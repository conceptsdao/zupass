import { Biome, IFrogData, Rarity } from "@pcd/eddsa-frog-pcd";
import {
  FrogCryptoComputedUserState,
  FrogCryptoDeleteFrogsRequest,
  FrogCryptoDeleteFrogsResponseValue,
  FrogCryptoFeed,
  FrogCryptoFolderName,
  FrogCryptoFrogData,
  FrogCryptoScore,
  FrogCryptoUpdateFeedsRequest,
  FrogCryptoUpdateFeedsResponseValue,
  FrogCryptoUpdateFrogsRequest,
  FrogCryptoUpdateFrogsResponseValue,
  FrogCryptoUserStateRequest,
  FrogCryptoUserStateResponseValue,
  ListFeedsRequest,
  ListFeedsResponseValue,
  ListSingleFeedRequest,
  PollFeedRequest,
  PollFeedResponseValue,
  verifyFeedCredential
} from "@pcd/passport-interface";
import { PCDActionType } from "@pcd/pcd-collection";
import { SerializedPCD } from "@pcd/pcd-types";
import { SemaphoreSignaturePCD } from "@pcd/semaphore-signature-pcd";
import _ from "lodash";
import { FrogCryptoUserFeedState } from "../database/models";
import {
  deleteFrogData,
  fetchUserFeedsState,
  getFrogData,
  getPossibleFrogIds,
  getRawFeedData,
  getScoreboard,
  getUserScore,
  incrementScore,
  initializeUserFeedState,
  sampleFrogData,
  updateUserFeedState,
  upsertFeedData,
  upsertFrogData
} from "../database/queries/frogcrypto";
import { fetchUserByCommitment } from "../database/queries/users";
import { sqlTransaction } from "../database/sqlQuery";
import { PCDHTTPError } from "../routing/pcdHttpError";
import { ApplicationContext } from "../types";
import {
  FrogCryptoFeedHost,
  parseFrogEnum,
  parseFrogTemperament,
  sampleFrogAttribute
} from "../util/frogcrypto";
import { logger } from "../util/logger";
import { IssuanceService } from "./issuanceService";
import { RollbarService } from "./rollbarService";

export class FrogcryptoService {
  private readonly context: ApplicationContext;
  private readonly rollbarService: RollbarService | null;
  private readonly issuanceService: IssuanceService;
  private readonly feedHost: FrogCryptoFeedHost;
  private readonly adminUsers: string[];

  public constructor(
    context: ApplicationContext,
    rollbarService: RollbarService | null,
    issuanceService: IssuanceService
  ) {
    this.context = context;
    this.rollbarService = rollbarService;
    this.issuanceService = issuanceService;
    this.feedHost = new FrogCryptoFeedHost(
      this.context.dbPool,
      (feed: FrogCryptoFeed) =>
        async (req: PollFeedRequest): Promise<PollFeedResponseValue> => {
          try {
            if (feed.activeUntil <= Date.now() / 1000) {
              throw new PCDHTTPError(403, "Feed is not active");
            }

            if (req.pcd === undefined) {
              throw new PCDHTTPError(400, `Missing credential`);
            }
            await verifyFeedCredential(
              req.pcd,
              this.issuanceService.cachedVerifySignaturePCD
            );

            return {
              actions: [
                {
                  pcds: await this.issuanceService.issueEdDSAFrogPCDs(
                    req.pcd,
                    await this.reserveFrogData(req.pcd, feed)
                  ),
                  folder: FrogCryptoFolderName,
                  type: PCDActionType.AppendToFolder
                }
              ]
            };
          } catch (e) {
            if (e instanceof PCDHTTPError) {
              throw e;
            }

            logger(`Error encountered while serving feed:`, e);
            this.rollbarService?.reportError(e);
          }
          return { actions: [] };
        }
    );
    this.adminUsers = this.getAdminUsers();
  }

  public async handleListFeedsRequest(
    request: ListFeedsRequest
  ): Promise<ListFeedsResponseValue> {
    return this.feedHost.handleListFeedsRequest(request);
  }

  public async handleListSingleFeedRequest(
    request: ListSingleFeedRequest
  ): Promise<ListFeedsResponseValue> {
    return this.feedHost.handleListSingleFeedRequest(request);
  }

  public async handleFeedRequest(
    request: PollFeedRequest
  ): Promise<PollFeedResponseValue> {
    return this.feedHost.handleFeedRequest(request);
  }

  public hasFeedWithId(feedId: string): boolean {
    return this.feedHost.hasFeedWithId(feedId);
  }

  public async getUserState(
    req: FrogCryptoUserStateRequest
  ): Promise<FrogCryptoUserStateResponseValue> {
    const semaphoreId = await this.cachedVerifyPCDAndGetSemaphoreId(req.pcd);

    const userFeeds = await fetchUserFeedsState(
      this.context.dbPool,
      semaphoreId
    );

    const allFeeds = _.keyBy(this.feedHost.getAllFeeds(), "id");

    return {
      feeds: userFeeds
        .filter((userFeed) => allFeeds[userFeed.feed_id])
        .map((userFeed) =>
          this.computeUserFeedState(userFeed, allFeeds[userFeed.feed_id])
        ),
      possibleFrogIds: await getPossibleFrogIds(this.context.dbPool),
      myScore: await getUserScore(this.context.dbPool, semaphoreId)
    };
  }

  private async reserveFrogData(
    pcd: SerializedPCD<SemaphoreSignaturePCD>,
    feed: FrogCryptoFeed
  ): Promise<IFrogData> {
    const semaphoreId = await this.cachedVerifyPCDAndGetSemaphoreId(pcd);

    await initializeUserFeedState(this.context.dbPool, semaphoreId, feed.id);

    return sqlTransaction(
      this.context.dbPool,
      "reserve frog",
      async (client) => {
        const lastFetchedAt = await updateUserFeedState(
          client,
          semaphoreId,
          feed.id
        ).catch((e) => {
          if (e.message.includes("could not obtain lock")) {
            throw new PCDHTTPError(
              429,
              "There is another frog request in flight!"
            );
          }
          throw e;
        });
        if (!lastFetchedAt) {
          const e = new Error("User feed state unexpectedly not found!");
          logger(`Error encountered while serving feed:`, e);
          throw e;
        }

        const { nextFetchAt } = this.computeUserFeedState(
          {
            semaphore_id: semaphoreId,
            feed_id: feed.id,
            last_fetched_at: lastFetchedAt
          },
          feed
        );
        if (nextFetchAt > Date.now()) {
          throw new PCDHTTPError(403, `Next fetch available at ${nextFetchAt}`);
        }

        const frogData = await sampleFrogData(this.context.dbPool, feed.biomes);
        if (!frogData) {
          throw new PCDHTTPError(404, "Frog Not Found");
        }
        await incrementScore(client, semaphoreId);

        return this.generateFrogData(frogData, semaphoreId);
      }
    );
  }

  /**
   * Upsert frog data into the database and return all frog data.
   */
  public async updateFrogData(
    req: FrogCryptoUpdateFrogsRequest
  ): Promise<FrogCryptoUpdateFrogsResponseValue> {
    await this.cachedVerifyAdminSignaturePCD(req.pcd);

    try {
      await upsertFrogData(this.context.dbPool, req.frogs);
    } catch (e) {
      logger(`Error encountered while inserting frog data:`, e);
      throw new PCDHTTPError(500, `Error inserting frog data: ${e}`);
    }

    return {
      frogs: await getFrogData(this.context.dbPool)
    };
  }

  /**
   * Delete frog data from the database and return all frog data.
   */
  public async deleteFrogData(
    req: FrogCryptoDeleteFrogsRequest
  ): Promise<FrogCryptoDeleteFrogsResponseValue> {
    await this.cachedVerifyAdminSignaturePCD(req.pcd);

    await deleteFrogData(this.context.dbPool, req.frogIds);

    return {
      frogs: await getFrogData(this.context.dbPool)
    };
  }

  /**
   * Return default number of top scores.
   */
  public async getScoreboard(): Promise<FrogCryptoScore[]> {
    return getScoreboard(this.context.dbPool);
  }

  /**
   * Upsert feed data into the database and return all raw feed data.
   */
  public async updateFeedData(
    req: FrogCryptoUpdateFeedsRequest
  ): Promise<FrogCryptoUpdateFeedsResponseValue> {
    await this.cachedVerifyAdminSignaturePCD(req.pcd);

    try {
      await upsertFeedData(this.context.dbPool, req.feeds);
      // nb: refresh in-memory feed cache. As of 2023/11, we run a single
      // server. Once we scale out, servers may return stale data. See @{link
      // feedHost#refreshFeeds} on how to fix.
      await this.feedHost.refreshFeeds();
    } catch (e) {
      logger(`Error encountered while inserting frog data:`, e);
      throw new PCDHTTPError(500, `Error inserting frog data: ${e}`);
    }

    return {
      feeds: await getRawFeedData(this.context.dbPool)
    };
  }

  public async start(): Promise<void> {
    await this.feedHost.start();
  }

  public stop(): void {
    this.feedHost.stop();
  }

  private computeUserFeedState(
    state: FrogCryptoUserFeedState | undefined,
    feed: FrogCryptoFeed
  ): FrogCryptoComputedUserState {
    const lastFetchedAt = state?.last_fetched_at?.getTime() ?? 0;
    const nextFetchAt = lastFetchedAt + feed.cooldown * 1000;

    return {
      feedId: feed.id,
      lastFetchedAt,
      nextFetchAt,
      active: feed.activeUntil > Date.now() / 1000
    };
  }

  private generateFrogData(
    frogData: FrogCryptoFrogData,
    ownerSemaphoreId: string
  ): IFrogData {
    return {
      ..._.pick(frogData, "name", "description"),
      imageUrl: `${process.env.PASSPORT_SERVER_URL}/frogcrypto/images/${frogData.uuid}`,
      frogId: frogData.id,
      biome: parseFrogEnum(Biome, frogData.biome),
      rarity: parseFrogEnum(Rarity, frogData.rarity),
      temperament: parseFrogTemperament(frogData.temperament),
      jump: sampleFrogAttribute(frogData.jump_min, frogData.jump_max),
      speed: sampleFrogAttribute(frogData.speed_min, frogData.speed_max),
      intelligence: sampleFrogAttribute(
        frogData.intelligence_min,
        frogData.intelligence_max
      ),
      beauty: sampleFrogAttribute(frogData.beauty_min, frogData.beauty_max),
      timestampSigned: Date.now(),
      ownerSemaphoreId
    };
  }

  private async cachedVerifyPCDAndGetSemaphoreId(
    serializedPCD: SerializedPCD<SemaphoreSignaturePCD>
  ): Promise<string> {
    try {
      const { pcd } = await verifyFeedCredential(
        serializedPCD,
        this.issuanceService.cachedVerifySignaturePCD
      );
      return pcd.claim.identityCommitment;
    } catch (e) {
      throw new PCDHTTPError(400, "invalid PCD");
    }
  }

  /**
   * Verify signature PCD against a static list of admin identities.
   */
  private async cachedVerifyAdminSignaturePCD(
    pcd: SerializedPCD<SemaphoreSignaturePCD>
  ): Promise<void> {
    const id = await this.cachedVerifyPCDAndGetSemaphoreId(pcd);
    const user = await fetchUserByCommitment(this.context.dbPool, id);
    if (!user) {
      throw new PCDHTTPError(400, "invalid PCD");
    }
    if (!this.adminUsers.includes(user.email)) {
      throw new PCDHTTPError(403, "not authorized");
    }
  }

  private getAdminUsers(): string[] {
    try {
      const res = JSON.parse(process.env.FROGCRYPTO_ADMIN_USER_EMAILS || "[]");
      if (!Array.isArray(res) || res.some((e) => typeof e !== "string")) {
        throw new Error("admin users must be an array of strings");
      }
      if (res.length === 0) {
        logger("[FROGCRYPTO] No admin users configured");
      }
      return res;
    } catch (e) {
      logger("[FROGCRYPTO] Failed to load admin users", e);
      this.rollbarService?.reportError(e);
      return [];
    }
  }
}

export async function startFrogcryptoService(
  context: ApplicationContext,
  rollbarService: RollbarService | null,
  issuanceService: IssuanceService | null
): Promise<FrogcryptoService | null> {
  if (!issuanceService) {
    logger("[FROGCRYPTO] Issuance service not configured");
    return null;
  }

  const service = new FrogcryptoService(
    context,
    rollbarService,
    issuanceService
  );
  await service.start();

  return service;
}
