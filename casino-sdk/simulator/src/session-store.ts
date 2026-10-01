// In-browser stand-in for the indexed session feed the production host reads.
// Events arrive from the local chain after the simulated indexing lag and
// evolve one row per session with the same monotonic rules the production
// pipeline applies (terminal state absorbing, per-request randomness tracking,
// no regressing behind fulfilled randomness).
import type { CasinoSessionRow } from './casino';
import type { CasinoSessionChainEvent } from './session-events';

type RandomnessRequest = NonNullable<CasinoSessionRow['randomnessRequests']>[number];

// SETTLED / FORFEITED / CANCELLED.
const isTerminalPhase = (phase: number) => phase >= 3;

// Multi-step games make several randomness requests per session, so every
// request is tracked in a nonce-keyed list. Upserts are idempotent and a
// fulfilled entry is never downgraded by a replayed request.
function upsertRandomnessRequest(
  requests: RandomnessRequest[] | undefined,
  entry: RandomnessRequest,
): RandomnessRequest[] {
  const list = requests ? [...requests] : [];
  const index = list.findIndex(request => request.nonce === entry.nonce);
  if (index === -1) {
    list.push(entry);
    return list.sort((a, b) => (BigInt(a.nonce) < BigInt(b.nonce) ? -1 : 1));
  }
  if (!list[index]!.fulfilled) {
    list[index] = { ...list[index]!, ...entry };
  }
  return list;
}

function initialRow(sessionId: string, chainId: number): CasinoSessionRow {
  return {
    sessionId,
    chainId,
    game: '0x',
    gameName: '',
    player: '0x',
    vault: '0x',
    token: '0x',
    tokenDecimals: 18,
    wager: '0',
    maxEscrowStake: '0',
    maxReservedProfit: '0',
    status: 'open',
    phase: 0,
    openedAt: 0,
  };
}

function evolve(state: CasinoSessionRow, event: CasinoSessionChainEvent): CasinoSessionRow {
  switch (event.eventName) {
    case 'CasinoSessionOpened':
      return {
        ...state,
        game: event.game.toLowerCase(),
        gameName: event.gameName,
        player: event.player.toLowerCase(),
        vault: event.vault.toLowerCase(),
        token: event.token.toLowerCase(),
        tokenDecimals: event.tokenDecimals,
        wager: event.wager,
        stake: state.stake ?? event.wager,
        maxEscrowStake: event.maxEscrowStake,
        maxReservedProfit: event.maxReservedProfit,
        gameData: event.gameData,
        // A replayed/late open event may arrive after settlement. Fill the
        // immutable opening fields without regressing the lifecycle.
        status: state.status === 'settled' ? 'settled' : 'open',
        openedAt: event.timestamp,
        openTransactionHash: event.transactionHash,
      };
    case 'CasinoSessionEscrowUpdated':
      // Emitted before the same step's phase advance, so state.step still
      // trails the event's step; an equal-or-lower step is a replay.
      if (state.step !== undefined && event.step <= state.step) return state;
      return { ...state, stake: event.escrowedStake };
    case 'CasinoSessionPhaseAdvanced':
      // Terminal state is absorbing: an out-of-order WAITING_RANDOMNESS event
      // must never overwrite a settled phase/gameState.
      if (state.status === 'settled') return state;
      // The facet emits the terminal phase advance and CasinoSessionSettled in
      // the same transaction; only the latter carries the payout, so applying
      // the advance alone would present a terminal session without its result.
      if (isTerminalPhase(event.phase)) return state;
      // The facet emits exactly one advance per step and steps strictly
      // increase, so an equal-or-lower step is a replayed/out-of-order event.
      // (Multi-step games legitimately return to WAITING_RANDOMNESS on every
      // action, so the phase alone can't identify a regression.)
      if (state.step !== undefined && event.step <= state.step) return state;
      return {
        ...state,
        step: event.step,
        phase: event.phase,
        actionDeadlineBlock: event.actionDeadlineBlock,
        randomnessDeadlineBlock: event.randomnessDeadlineBlock,
        gameState: event.gameState,
      };
    case 'CasinoSessionRandomnessRequested': {
      const randomnessRequests = upsertRandomnessRequest(state.randomnessRequests, {
        nonce: event.requestNonce,
        requestId: event.requestId,
        fulfilled: false,
      });
      // The current-request fields track the latest request. Multi-step games
      // request randomness repeatedly, so only a replay — this request already
      // fulfilled, or a newer request already known — must not reset them.
      const isReplay = randomnessRequests.some(
        request =>
          (request.nonce === event.requestNonce && request.fulfilled) ||
          BigInt(request.nonce) > BigInt(event.requestNonce),
      );
      if (state.status === 'settled' || isReplay) {
        return { ...state, randomnessRequests };
      }
      return {
        ...state,
        randomnessRequestId: event.requestId,
        randomnessFulfilled: false,
        randomnessDeadlineBlock: event.randomnessDeadlineBlock,
        randomnessRequests,
      };
    }
    case 'CasinoSessionRandomnessFulfilled': {
      const randomnessRequests = upsertRandomnessRequest(state.randomnessRequests, {
        nonce: event.requestNonce,
        requestId: event.requestId,
        randomness: event.randomness,
        fulfilled: true,
        transactionHash: event.transactionHash,
      });
      // The session-level flag refers to the latest request: a replayed
      // fulfillment of an older request must not mark a newer pending one.
      const isLatest = !randomnessRequests.some(
        request => BigInt(request.nonce) > BigInt(event.requestNonce),
      );
      return {
        ...state,
        randomnessFulfilled: isLatest ? true : (state.randomnessFulfilled ?? false),
        randomnessRequests,
      };
    }
    case 'CasinoSessionSettled':
      return {
        ...state,
        game: event.game.toLowerCase(),
        gameName: event.gameName,
        player: event.player.toLowerCase(),
        phase: event.phase,
        payout: event.payout,
        gameState: event.gameState,
        status: 'settled',
        settledAt: event.timestamp,
        settleTransactionHash: event.transactionHash,
      };
  }
}

export type SessionStore = {
  applyEvent: (event: CasinoSessionChainEvent) => void;
  /** The player's sessions for one game, newest first — the query shape games see. */
  listByPlayerAndGame: (player: string, game: string, limit?: number) => CasinoSessionRow[];
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
};

export function createSessionStore(chainId: number): SessionStore {
  const rows = new Map<string, CasinoSessionRow>();
  const listeners = new Set<() => void>();
  let version = 0;

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    applyEvent: event => {
      const current = rows.get(event.sessionId) ?? initialRow(event.sessionId, chainId);
      const next = evolve(current, event);
      if (next === current) return;
      rows.set(event.sessionId, next);
      notify();
    },
    listByPlayerAndGame: (player, game, limit = 50) => {
      const playerKey = player.toLowerCase();
      const gameKey = game.toLowerCase();
      return [...rows.values()]
        .filter(row => row.player === playerKey && row.game === gameKey)
        .sort((a, b) =>
          a.openedAt === b.openedAt
            ? Number(BigInt(b.sessionId) - BigInt(a.sessionId))
            : b.openedAt - a.openedAt,
        )
        .slice(0, limit);
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
  };
}
