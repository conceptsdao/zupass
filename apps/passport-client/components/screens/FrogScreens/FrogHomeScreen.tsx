import { isEdDSAFrogPCD } from "@pcd/eddsa-frog-pcd";
import {
  CredentialManager,
  FrogCryptoFolderName,
  FrogCryptoUserStateResponseValue,
  requestFrogCryptoGetUserState
} from "@pcd/passport-interface";
import { useCallback, useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { appConfig } from "../../../src/appConfig";
import {
  useCredentialCache,
  useDispatch,
  useIdentity,
  useIsSyncSettled,
  usePCDCollection,
  usePCDsInFolder,
  useSubscriptions
} from "../../../src/appHooks";
import { useSyncE2EEStorage } from "../../../src/useSyncE2EEStorage";
import { H1 } from "../../core";
import { MaybeModal } from "../../modals/Modal";
import { AppContainer } from "../../shared/AppContainer";
import { AppHeader } from "../../shared/AppHeader";
import { SyncingPCDs } from "../../shared/SyncingPCDs";
import { ActionButton, Button, ButtonGroup } from "./Button";
import { DexTab } from "./DexTab";
import { SuperFunkyFont } from "./FrogFolder";
import { GetFrogTab } from "./GetFrogTab";
import { ScoreTab } from "./ScoreTab";

const TABS = [
  {
    tab: "get",
    label: "get frogs"
  },
  {
    tab: "score",
    label: "hi scores"
  },
  {
    tab: "dex",
    label: "frogedex"
  }
] as const;
type TabId = (typeof TABS)[number]["tab"];

/** A placeholder screen for FrogCrypto.
 *
 * We might want to consider slotting this into the existing HomeScreen to better integrate with PCD explorer.
 */
export function FrogHomeScreen() {
  useSyncE2EEStorage();
  const syncSettled = useIsSyncSettled();
  const frogPCDs = usePCDsInFolder(FrogCryptoFolderName).filter(isEdDSAFrogPCD);
  const { userState, refreshUserState } = useUserFeedState();
  const subs = useSubscriptions();
  const frogSubs = useMemo(
    () =>
      subs.value
        .getActiveSubscriptions()
        .filter((sub) => sub.providerUrl.includes("frogcrypto")),
    [subs]
  );
  const initFrog = useInitializeFrogSubscriptions();
  const [tab, setTab] = useState<TabId>("get");

  if (!syncSettled) {
    return <SyncingPCDs />;
  }

  return (
    <>
      <MaybeModal />
      <AppContainer bg="gray">
        <Container>
          <AppHeader />

          <SuperFunkyFont>
            <H1 style={{ margin: "0 auto" }}>{FrogCryptoFolderName}</H1>
          </SuperFunkyFont>

          {userState?.myScore?.score && (
            <Score>Score {userState?.myScore?.score}</Score>
          )}

          {frogSubs.length === 0 && (
            <ActionButton onClick={initFrog}>light fire</ActionButton>
          )}
          {frogSubs.length > 0 &&
            (frogPCDs.length === 0 ? (
              <GetFrogTab
                subscriptions={frogSubs}
                userState={userState}
                refreshUserState={refreshUserState}
                pcds={frogPCDs}
              />
            ) : (
              <>
                <ButtonGroup>
                  {TABS.map(({ tab: t, label }) => (
                    <Button
                      key={t}
                      disabled={tab === t}
                      onClick={() => setTab(t)}
                    >
                      {label}
                    </Button>
                  ))}
                </ButtonGroup>

                {tab === "get" && (
                  <GetFrogTab
                    subscriptions={frogSubs}
                    userState={userState}
                    refreshUserState={refreshUserState}
                    pcds={frogPCDs}
                  />
                )}
                {tab === "score" && <ScoreTab score={userState?.myScore} />}
                {tab === "dex" && (
                  <DexTab
                    possibleFrogIds={userState.possibleFrogIds}
                    pcds={frogPCDs}
                  />
                )}
              </>
            ))}
        </Container>
      </AppContainer>
    </>
  );
}

/**
 * Fetch the user's frog crypto state as well as the ability to refetch.
 */
function useUserFeedState() {
  const [userState, setUserState] =
    useState<FrogCryptoUserStateResponseValue>();
  const identity = useIdentity();
  const pcds = usePCDCollection();
  const credentialCache = useCredentialCache();
  const credentialManager = useMemo(
    () => new CredentialManager(identity, pcds, credentialCache),
    [credentialCache, identity, pcds]
  );
  const refreshUserState = useCallback(async () => {
    const pcd = await credentialManager.requestCredential({
      signatureType: "sempahore-signature-pcd"
    });

    const state = await requestFrogCryptoGetUserState(appConfig.zupassServer, {
      pcd
    });

    setUserState(state.value);
  }, [credentialManager]);
  useEffect(() => {
    refreshUserState();
  }, [refreshUserState]);

  return useMemo(
    () => ({
      userState,
      refreshUserState
    }),
    [userState, refreshUserState]
  );
}

const DEFAULT_FROG_SUBSCRIPTION_PROVIDER_URL = `${appConfig.zupassServer}/frogcrypto/feeds`;

/**
 * Returns a callback to register the default frog subscription provider and
 * subscribes to all public frog feeds.
 */
const useInitializeFrogSubscriptions: () => () => Promise<void> = () => {
  const dispatch = useDispatch();
  const { value: subs } = useSubscriptions();

  return useCallback(async () => {
    subs.getOrAddProvider(
      DEFAULT_FROG_SUBSCRIPTION_PROVIDER_URL,
      FrogCryptoFolderName
    );

    // Subscribe to public feeds. We don't check for duplicates here because
    // this function should only be called if user has no frog subscriptions.
    await subs.listFeeds(DEFAULT_FROG_SUBSCRIPTION_PROVIDER_URL).then((res) =>
      res.feeds.forEach((feed) =>
        dispatch({
          type: "add-subscription",
          providerUrl: DEFAULT_FROG_SUBSCRIPTION_PROVIDER_URL,
          providerName: FrogCryptoFolderName,
          feed
        })
      )
    );
  }, [dispatch, subs]);
};

const Container = styled.div`
  padding: 16px;
  width: 100%;
  height: 100%;
  max-width: 100%;

  display: flex;
  flex-direction: column;
  gap: 32px;
`;

const Score = styled.div`
  font-size: 16px;
  text-align: center;
`;
