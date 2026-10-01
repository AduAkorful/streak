// Decoded casino session events, normalized to the string/number shapes the
// session rows use.
import type { Address, Hex, Log, PublicClient } from 'viem';
import { decodeEventLog } from 'viem';

import { casinoSessionEventsAbi } from './casino-abi';
import { toAddress } from './casino';

export type CasinoSessionChainEvent = {
  transactionHash: Hex;
  sessionId: string;
  blockNumber: bigint;
  /** Block timestamp in seconds. */
  timestamp: number;
} & (
  | {
      eventName: 'CasinoSessionOpened';
      game: Address;
      player: Address;
      vault: Address;
      token: Address;
      tokenDecimals: number;
      wager: string;
      maxEscrowStake: string;
      maxReservedProfit: string;
      gameName: string;
      gameData: Hex;
    }
  | {
      eventName: 'CasinoSessionEscrowUpdated';
      step: number;
      previousEscrowedStake: string;
      escrowedStake: string;
    }
  | {
      eventName: 'CasinoSessionPhaseAdvanced';
      step: number;
      phase: number;
      actionDeadlineBlock: string;
      randomnessDeadlineBlock: string;
      gameState: Hex;
    }
  | {
      eventName: 'CasinoSessionRandomnessRequested';
      requestId: Hex;
      requestNonce: string;
      randomnessDeadlineBlock: string;
    }
  | {
      eventName: 'CasinoSessionRandomnessFulfilled';
      requestId: Hex;
      requestNonce: string;
      randomness: Hex;
    }
  | {
      eventName: 'CasinoSessionSettled';
      game: Address;
      player: Address;
      phase: number;
      payout: string;
      gameName: string;
      gameState: Hex;
    }
);

function normalizeLog(log: Log, timestamp: number): CasinoSessionChainEvent | undefined {
  if (!log.transactionHash || log.blockNumber === null || log.data === undefined) return undefined;
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({
      abi: casinoSessionEventsAbi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
  } catch {
    return undefined;
  }
  const args = decoded.args as Record<string, unknown>;
  const base = {
    transactionHash: log.transactionHash,
    sessionId: String(args.sessionId),
    blockNumber: log.blockNumber,
    timestamp,
  };

  switch (decoded.eventName) {
    case 'CasinoSessionOpened':
      return {
        ...base,
        eventName: 'CasinoSessionOpened',
        game: toAddress(String(args.game)),
        player: toAddress(String(args.player)),
        vault: toAddress(String(args.vault)),
        token: toAddress(String(args.token)),
        tokenDecimals: Number(args.tokenDecimals),
        wager: String(args.wager),
        maxEscrowStake: String(args.maxEscrowStake),
        maxReservedProfit: String(args.maxReservedProfit),
        gameName: String(args.gameName),
        gameData: args.gameData as Hex,
      };
    case 'CasinoSessionEscrowUpdated':
      return {
        ...base,
        eventName: 'CasinoSessionEscrowUpdated',
        step: Number(args.step),
        previousEscrowedStake: String(args.previousEscrowedStake),
        escrowedStake: String(args.escrowedStake),
      };
    case 'CasinoSessionPhaseAdvanced':
      return {
        ...base,
        eventName: 'CasinoSessionPhaseAdvanced',
        step: Number(args.step),
        phase: Number(args.phase),
        actionDeadlineBlock: String(args.actionDeadlineBlock),
        randomnessDeadlineBlock: String(args.randomnessDeadlineBlock),
        gameState: args.gameState as Hex,
      };
    case 'CasinoSessionRandomnessRequested':
      return {
        ...base,
        eventName: 'CasinoSessionRandomnessRequested',
        requestId: args.requestId as Hex,
        requestNonce: String(args.requestNonce),
        randomnessDeadlineBlock: String(args.randomnessDeadlineBlock),
      };
    case 'CasinoSessionRandomnessFulfilled':
      return {
        ...base,
        eventName: 'CasinoSessionRandomnessFulfilled',
        requestId: args.requestId as Hex,
        requestNonce: String(args.requestNonce),
        randomness: args.randomness as Hex,
      };
    case 'CasinoSessionSettled':
      return {
        ...base,
        eventName: 'CasinoSessionSettled',
        game: toAddress(String(args.game)),
        player: toAddress(String(args.player)),
        phase: Number(args.phase),
        payout: String(args.payout),
        gameName: String(args.gameName),
        gameState: args.gameState as Hex,
      };
    default:
      return undefined;
  }
}

export type SessionEventListener = (event: CasinoSessionChainEvent) => void;

export type SessionEventFeed = {
  /** Fires near-instantly, like the production host's flashblock event push. */
  subscribeFlashblock: (listener: SessionEventListener) => () => void;
  /** Fires after the simulated indexing lag, like the host's session feed. */
  subscribeIndexed: (listener: SessionEventListener) => () => void;
  stop: () => void;
};

/**
 * Watches the casino host for the casino session events and fans each one out on
 * two channels that emulate production timing: the flashblock channel (the
 * host observes flashblocks — sub-block preconfirmations — so events land
 * near-instantly) and the indexed channel (the durable session feed, delivered
 * after a configurable lag). Historical logs are replayed on the indexed
 * channel only, without lag — an indexer would already have them.
 */
export function createSessionEventFeed(input: {
  publicClient: PublicClient;
  proxy: Address;
  flashblockLagMs: () => number;
  indexerLagMs: () => number;
}): SessionEventFeed {
  const { publicClient, proxy } = input;
  const flashblockListeners = new Set<SessionEventListener>();
  const indexedListeners = new Set<SessionEventListener>();
  const seen = new Set<string>();
  const blockTimestamps = new Map<bigint, number>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = (listeners: Set<SessionEventListener>, event: CasinoSessionChainEvent) => {
    for (const listener of listeners) listener(event);
  };

  const emitDelayed = (
    listeners: Set<SessionEventListener>,
    event: CasinoSessionChainEvent,
    delayMs: number,
  ) => {
    if (delayMs <= 0) {
      emit(listeners, event);
      return;
    }
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (!stopped) emit(listeners, event);
    }, delayMs);
    pendingTimers.add(timer);
  };

  const blockTimestamp = async (blockNumber: bigint): Promise<number> => {
    const cached = blockTimestamps.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await publicClient.getBlock({ blockNumber });
    const timestamp = Number(block.timestamp);
    blockTimestamps.set(blockNumber, timestamp);
    return timestamp;
  };

  const normalize = async (log: Log): Promise<CasinoSessionChainEvent | undefined> => {
    if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
      return undefined;
    }
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    return normalizeLog(log, await blockTimestamp(log.blockNumber));
  };

  // Range-tracked getLogs polling instead of a filter-based watcher: filters
  // are consume-once, so a transient RPC error (or a node restart) silently
  // drops the consumed logs — a lost CasinoSessionSettled leaves the round
  // stuck forever with nothing to recover it. Tracking the next unprocessed
  // block means a failed poll simply retries the same range.
  const start = async () => {
    const startBlock = await publicClient.getBlockNumber();
    const historical = await publicClient.getLogs({
      address: proxy,
      events: casinoSessionEventsAbi,
      fromBlock: 0n,
      toBlock: startBlock,
    });
    if (stopped) return;
    for (const log of historical) {
      const event = await normalize(log);
      if (event) emit(indexedListeners, event);
    }

    let fromBlock = startBlock + 1n;
    const poll = async () => {
      try {
        const head = await publicClient.getBlockNumber();
        if (head >= fromBlock) {
          const logs = await publicClient.getLogs({
            address: proxy,
            events: casinoSessionEventsAbi,
            fromBlock,
            toBlock: head,
          });
          for (const log of logs) {
            const event = await normalize(log);
            if (!event || stopped) continue;
            emitDelayed(flashblockListeners, event, input.flashblockLagMs());
            emitDelayed(indexedListeners, event, input.indexerLagMs());
          }
          fromBlock = head + 1n;
        }
      } catch {
        // Retry the same range on the next tick — nothing is lost.
      }
      if (!stopped) pollTimer = setTimeout(() => void poll(), 150);
    };
    void poll();
  };

  void start().catch(() => undefined);

  return {
    subscribeFlashblock: listener => {
      flashblockListeners.add(listener);
      return () => flashblockListeners.delete(listener);
    },
    subscribeIndexed: listener => {
      indexedListeners.add(listener);
      return () => indexedListeners.delete(listener);
    },
    stop: () => {
      stopped = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    },
  };
}
