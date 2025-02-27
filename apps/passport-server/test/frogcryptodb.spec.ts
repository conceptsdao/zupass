import { FrogCryptoDbFeedData } from "@pcd/passport-interface";
import { expect } from "chai";
import "mocha";
import { step } from "mocha-steps";
import { Client } from "pg";
import { Pool } from "postgres-pool";
import { getDB } from "../src/database/postgresPool";
import {
  deleteFrogData,
  fetchUserFeedsState,
  getFeedData,
  getFrogData,
  getPossibleFrogIds,
  initializeUserFeedState,
  sampleFrogData,
  updateUserFeedState,
  upsertFeedData,
  upsertFrogData
} from "../src/database/queries/frogcrypto";
import { overrideEnvironment, testingEnv } from "./util/env";
import { testFeeds, testFrogs, testFrogsAndObjects } from "./util/frogcrypto";

describe("database reads and writes for frogcrypto features", function () {
  this.timeout(15_000);

  let db: Pool;
  let client: Client;

  this.beforeAll(async () => {
    await overrideEnvironment(testingEnv);
    db = await getDB();
    client = await db.connect();
  });

  this.afterAll(async () => {
    await client.end();
    await db.end();
  });

  step("database should initialize", async function () {
    expect(db).to.not.eq(null);
  });

  step("insert frogs", async function () {
    await upsertFrogData(db, testFrogs);

    const allFrogs = await getFrogData(db);
    expect(allFrogs.length).to.eq(testFrogs.length);
  });

  step("update frogs", async function () {
    const mutatedFrog = {
      ...testFrogs[3],
      biome: "Swamp"
    };
    await upsertFrogData(db, [mutatedFrog]);

    const allFrogs = await getFrogData(db);
    expect(allFrogs.length).to.eq(testFrogs.length);
    expect(allFrogs.find((frog) => frog.id === mutatedFrog.id)?.biome).to.eq(
      "Swamp"
    );
  });

  step("delete frogs", async function () {
    const frogId = testFrogs[3].id;
    await deleteFrogData(db, [frogId]);

    const allFrogs = await getFrogData(db);
    expect(allFrogs.length).to.eq(testFrogs.length - 1);
    expect(allFrogs.map((frog) => frog.id)).does.not.include(frogId);
  });

  step("sample a frog", async function () {
    const frog = await sampleFrogData(db, {
      Jungle: { dropWeightScaler: 1 }
    });

    expect(frog?.biome).to.eq("Jungle");
  });

  step("return undefined if there is no frog to sample", async function () {
    const frog = await sampleFrogData(db, {});

    expect(frog).to.be.undefined;
  });

  step("initialize user feed state", async function () {
    const emptyState = await fetchUserFeedsState(db, "test");
    expect(emptyState).to.be.empty;

    await initializeUserFeedState(db, "test", "test");
    let initState = await fetchUserFeedsState(db, "test");
    expect(initState).to.not.be.empty;
    let feedState = initState[0];
    expect(feedState.feed_id).to.eq("test");
    expect(feedState.last_fetched_at.getTime()).to.be.eq(0);

    // re-init should have no effect
    await initializeUserFeedState(db, "test", "test");
    initState = await fetchUserFeedsState(db, "test");
    expect(initState).to.not.be.empty;
    feedState = initState[0];
    expect(feedState.feed_id).to.eq("test");
    expect(feedState.last_fetched_at.getTime()).to.be.eq(0);
  });

  step("reserves only one update at a time", async function () {
    await client.query("BEGIN");
    const firstFetchedAt = await updateUserFeedState(client, "test", "test");
    expect(firstFetchedAt?.getTime()).to.be.eq(0);

    const client2 = await db.connect();
    await client2.query("BEGIN");
    await expect(
      updateUserFeedState(client2, "test", "test")
    ).to.be.rejectedWith("could not obtain lock");

    await client.query("COMMIT");
    await client2.query("COMMIT");
    await client2.release();

    const userFeedState = await fetchUserFeedsState(db, "test");
    expect(userFeedState[0].last_fetched_at.getTime()).to.be.greaterThan(0);
  });

  step("returns possible frog ids excluding objects", async function () {
    await upsertFrogData(db, testFrogsAndObjects);

    const possibleFrogIds = await getPossibleFrogIds(db);
    expect(possibleFrogIds).to.deep.eq([1, 2, 3, 7, 8]);
  });

  step("insert feeds", async function () {
    await upsertFeedData(db, testFeeds);

    const allFeeds = await getFeedData(db);
    expect(allFeeds.length).to.eq(testFeeds.length);
  });

  step("update feeds", async function () {
    const mutatedFeed = JSON.parse(
      JSON.stringify(testFeeds[3])
    ) as FrogCryptoDbFeedData;
    mutatedFeed.feed.private = false;
    await upsertFeedData(db, [mutatedFeed]);

    const allFeeds = await getFeedData(db);
    expect(allFeeds.length).to.eq(testFeeds.length);
    expect(
      allFeeds.find((feed) => feed.id === mutatedFeed.uuid)?.private
    ).to.eq(false);
  });

  step("upsert feeds", async function () {
    const mutatedFeed = JSON.parse(
      JSON.stringify(testFeeds[3])
    ) as FrogCryptoDbFeedData;
    mutatedFeed.feed.activeUntil = 0;
    const newFeed = {
      ...testFeeds[3],
      uuid: "065f829b-8aff-4f6a-9457-768a3a0d757b"
    };
    await upsertFeedData(db, [mutatedFeed, newFeed]);

    const allFeeds = await getFeedData(db);
    expect(allFeeds.length).to.eq(testFeeds.length + 1);
    expect(
      allFeeds.find((feed) => feed.id === mutatedFeed.uuid)?.activeUntil
    ).to.deep.eq(0);
    expect(allFeeds.find((feed) => feed.id === newFeed.uuid)).to.deep.include({
      id: newFeed.uuid,
      ...newFeed.feed
    });
  });
});
