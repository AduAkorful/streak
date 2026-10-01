// The harness's stand-in for the two live data paths of the production host:
// the indexed session feed and the near-instant flashblock push. Both are fed
// from the same local-chain event feed on channels with different simulated
// latency.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Address, Hex } from 'viem';

import { toAddress, type CasinoSessionRow } from './casino';
import {
  applyFlashblockEvent,
  pruneFlashblockPatches,
  type FlashblockSessionPatches,
} from './flashblock-session-patch';
import type { SimulatorRuntime } from './runtime';
import { useLatestRef } from './use-latest-ref';

/** Indexed rows for the player+game, newest first — what the host reads sessions from. */
export function useIndexedSessions(
  runtime: SimulatorRuntime,
  gameAddress: Address,
): CasinoSessionRow[] {
  const store = runtime.sessionStore;
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return useMemo(
    () => store.listByPlayerAndGame(runtime.account.address, gameAddress),
    [store, runtime.account.address, gameAddress, version],
  );
}

/**
 * Per-session patch layer fed by the flashblock channel, filtered to the
 * player's sessions for this game — the same accelerator the production host
 * runs. Sessions whose lifecycle events carry no player (phase/randomness)
 * are matched against session ids already known from own opens or indexed
 * rows.
 */
export function useFlashblockPatches({
  runtime,
  gameAddress,
  sessionRows,
  onSessionOpened,
}: {
  runtime: SimulatorRuntime;
  gameAddress: Address;
  sessionRows: CasinoSessionRow[] | undefined;
  onSessionOpened?: (sessionId: string, transactionHash: Hex) => void;
}): FlashblockSessionPatches {
  const [patches, setPatches] = useState<FlashblockSessionPatches>({});
  const knownSessionIdsRef = useRef(new Set<string>());
  const sessionRowsRef = useLatestRef(sessionRows);
  const onSessionOpenedRef = useLatestRef(onSessionOpened);

  useEffect(
    function updatePatches() {
      if (!sessionRows?.length) return;
      for (const row of sessionRows) knownSessionIdsRef.current.add(row.sessionId);
      setPatches(current => pruneFlashblockPatches(current, sessionRows));
    },
    [sessionRows],
  );

  useEffect(
    function watchFlashblockChannel() {
      const playerAddress = toAddress(runtime.account.address);
      const game = toAddress(gameAddress);
      knownSessionIdsRef.current = new Set(
        (sessionRowsRef.current ?? []).map(row => row.sessionId),
      );
      setPatches({});

      return runtime.feed.subscribeFlashblock(event => {
        if (
          event.eventName === 'CasinoSessionOpened' ||
          event.eventName === 'CasinoSessionSettled'
        ) {
          if (event.player !== playerAddress || event.game !== game) return;
          knownSessionIdsRef.current.add(event.sessionId);
        } else if (!knownSessionIdsRef.current.has(event.sessionId)) {
          return;
        }
        setPatches(current => applyFlashblockEvent(current, event));
        if (event.eventName === 'CasinoSessionOpened') {
          onSessionOpenedRef.current?.(event.sessionId, event.transactionHash);
        }
      });
    },
    [runtime, gameAddress, sessionRowsRef, onSessionOpenedRef],
  );

  return patches;
}

/** Open session whose randomness deadline has passed — cancelable for a refund. */
export function useStuckSessionId(
  runtime: SimulatorRuntime,
  sessionRows: CasinoSessionRow[] | undefined,
): string | undefined {
  const [currentBlock, setCurrentBlock] = useState<bigint | undefined>(undefined);

  useEffect(() => {
    return runtime.publicClient.watchBlockNumber({
      poll: true,
      pollingInterval: 5_000,
      onBlockNumber: blockNumber => setCurrentBlock(blockNumber),
      onError: () => undefined,
    });
  }, [runtime]);

  return useMemo(() => {
    if (currentBlock === undefined || !sessionRows) return undefined;
    return sessionRows.find(
      row =>
        row.status === 'open' &&
        row.phase === 1 &&
        !row.randomnessFulfilled &&
        row.randomnessDeadlineBlock !== undefined &&
        BigInt(row.randomnessDeadlineBlock) > 0n &&
        currentBlock > BigInt(row.randomnessDeadlineBlock),
    )?.sessionId;
  }, [currentBlock, sessionRows]);
}
