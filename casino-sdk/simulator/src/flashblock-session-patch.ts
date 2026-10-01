import type { Hex } from 'viem';

import type { CasinoSessionChainEvent } from './session-events';
import type { CasinoSessionItem } from './optimistic-casino-session';
import { isTerminalPhase, phaseName, type CasinoSessionRow } from './casino';

/**
 * Forward-only session state reconstructed from flashblock-pushed chain
 * events, keyed by sessionId. The production host maintains the same layer so
 * games see fresh state before the indexed session feed catches up: terminal
 * state is absorbing, and a session can never move backwards (e.g. behind
 * fulfilled randomness).
 */
export type FlashblockSessionPatch = {
  sessionId: string;
  openTransactionHash?: Hex;
  step?: number;
  phase?: number;
  actionDeadlineBlock?: string;
  randomnessDeadlineBlock?: string;
  gameState?: Hex;
  stake?: string;
  /** Step of the escrow update that produced `stake`. */
  stakeStep?: number;
  randomnessRequestId?: Hex;
  requestNonce?: string;
  randomnessFulfilled?: boolean;
  /** Latest fulfillment seen, kept even after a newer request supersedes it. */
  fulfilledRequestId?: Hex;
  fulfilledNonce?: string;
  randomness?: Hex;
  settled?: boolean;
  payout?: string;
  settledAt?: number;
  settleTransactionHash?: Hex;
};

export type FlashblockSessionPatches = Record<string, FlashblockSessionPatch>;

export function applyFlashblockEvent(
  patches: FlashblockSessionPatches,
  event: CasinoSessionChainEvent,
  now: number = Date.now(),
): FlashblockSessionPatches {
  const current = patches[event.sessionId] ?? { sessionId: event.sessionId };

  let next: FlashblockSessionPatch;
  switch (event.eventName) {
    case 'CasinoSessionOpened':
      next = { ...current, openTransactionHash: event.transactionHash };
      break;
    case 'CasinoSessionEscrowUpdated':
      if (current.settled) return patches;
      // Emitted before the same step's phase advance, so a replay is anything
      // at or behind the current step.
      if (current.step !== undefined && event.step <= current.step) return patches;
      next = { ...current, stake: event.escrowedStake, stakeStep: event.step };
      break;
    case 'CasinoSessionPhaseAdvanced':
      if (current.settled) return patches;
      // A terminal phase advance precedes the Settled event that carries the
      // payout and final gameState; skip it so the session is never presented
      // as settled without its result.
      if (isTerminalPhase(event.phase)) return patches;
      // One advance per step, strictly increasing — an equal-or-lower step is
      // a replay. Multi-step games legitimately return to WAITING_RANDOMNESS
      // on every action, so the phase alone can't identify a regression.
      if (current.step !== undefined && event.step <= current.step) return patches;
      next = {
        ...current,
        step: event.step,
        phase: event.phase,
        actionDeadlineBlock: event.actionDeadlineBlock,
        randomnessDeadlineBlock: event.randomnessDeadlineBlock,
        gameState: event.gameState,
      };
      break;
    case 'CasinoSessionRandomnessRequested':
      if (current.settled) return patches;
      // Only a genuinely new request (multi-step games request randomness per
      // action) supersedes the current one; duplicates and stale replays are
      // dropped by nonce.
      if (
        current.requestNonce !== undefined &&
        BigInt(event.requestNonce) <= BigInt(current.requestNonce)
      ) {
        return patches;
      }
      next = {
        ...current,
        randomnessRequestId: event.requestId,
        requestNonce: event.requestNonce,
        randomnessDeadlineBlock: event.randomnessDeadlineBlock,
        randomnessFulfilled: false,
      };
      break;
    case 'CasinoSessionRandomnessFulfilled':
      if (
        current.fulfilledNonce !== undefined &&
        BigInt(event.requestNonce) <= BigInt(current.fulfilledNonce)
      ) {
        return patches;
      }
      next = {
        ...current,
        randomnessFulfilled: true,
        randomnessRequestId: event.requestId,
        requestNonce: event.requestNonce,
        fulfilledRequestId: event.requestId,
        fulfilledNonce: event.requestNonce,
        randomness: event.randomness,
      };
      break;
    case 'CasinoSessionSettled':
      if (current.settled) return patches;
      next = {
        ...current,
        settled: true,
        phase: event.phase,
        payout: event.payout,
        gameState: event.gameState,
        settledAt: Math.floor(now / 1_000),
        settleTransactionHash: event.transactionHash,
      };
      break;
  }

  return { ...patches, [event.sessionId]: next };
}

/**
 * Overlays a patch onto an indexed session row, but only where the row is
 * still behind: the indexed feed always wins once it has caught up.
 */
export function mergeFlashblockPatchIntoRow(
  row: CasinoSessionRow,
  patch: FlashblockSessionPatch | undefined,
): CasinoSessionRow {
  if (!patch) return row;

  let merged = row;
  const rowIsTerminal = row.status === 'settled' || isTerminalPhase(row.phase);

  if (!rowIsTerminal) {
    if (patch.step !== undefined && patch.step > (row.step ?? -1)) {
      merged = {
        ...merged,
        step: patch.step,
        phase: patch.phase ?? merged.phase,
        actionDeadlineBlock: patch.actionDeadlineBlock ?? merged.actionDeadlineBlock,
        randomnessDeadlineBlock: patch.randomnessDeadlineBlock ?? merged.randomnessDeadlineBlock,
        gameState: patch.gameState ?? merged.gameState,
      };
    }
    if (
      patch.stake !== undefined &&
      patch.stakeStep !== undefined &&
      (merged.step ?? -1) < patch.stakeStep
    ) {
      merged = { ...merged, stake: patch.stake };
    }
    if (patch.settled && patch.payout !== undefined && patch.gameState !== undefined) {
      merged = {
        ...merged,
        status: 'settled',
        phase: patch.phase ?? merged.phase,
        payout: patch.payout,
        gameState: patch.gameState,
        settledAt: merged.settledAt ?? patch.settledAt,
        settleTransactionHash: merged.settleTransactionHash ?? patch.settleTransactionHash,
      };
    }
  }

  // Record the patch's latest fulfillment in the nonce-ordered request list so
  // the snapshot's "latest randomness" never regresses while the row catches
  // up. The session-level flag is only claimed when the fulfillment is for the
  // row's current request — a stale patch must not mask a newer pending
  // request (multi-step games), which would hide stuck-round recovery.
  if (patch.fulfilledNonce !== undefined && patch.fulfilledRequestId !== undefined) {
    const alreadyRecorded =
      row.randomnessRequests?.some(
        request => request.nonce === patch.fulfilledNonce && request.fulfilled,
      ) ?? false;
    if (!alreadyRecorded) {
      const entry = {
        nonce: patch.fulfilledNonce,
        requestId: patch.fulfilledRequestId,
        randomness: patch.randomness,
        fulfilled: true,
      };
      const requests = merged.randomnessRequests ? [...merged.randomnessRequests] : [];
      const index = requests.findIndex(request => request.nonce === entry.nonce);
      if (index === -1) {
        requests.push(entry);
        requests.sort((a, b) => (BigInt(a.nonce) < BigInt(b.nonce) ? -1 : 1));
      } else if (!requests[index]!.fulfilled) {
        requests[index] = { ...requests[index]!, ...entry };
      }
      const fulfillsCurrentRequest =
        row.randomnessRequestId === undefined ||
        row.randomnessRequestId === patch.fulfilledRequestId;
      merged = {
        ...merged,
        randomnessRequests: requests,
        ...(fulfillsCurrentRequest && !row.randomnessFulfilled
          ? {
              randomnessFulfilled: true,
              randomnessRequestId: merged.randomnessRequestId ?? patch.fulfilledRequestId,
            }
          : {}),
      };
    }
  }

  return merged;
}

/**
 * Overlays a patch onto an optimistic host item that has no indexed row yet,
 * so fresh chain state (phase, gameState, payout) reaches the iframe before
 * the indexed feed delivers it. The settled flip is atomic: a terminal phase
 * is only exposed together with its payout and gameState.
 */
export function mergeFlashblockPatchIntoItem(
  item: CasinoSessionItem,
  patch: FlashblockSessionPatch | undefined,
): CasinoSessionItem {
  if (!patch || item.isSettled) return item;

  if (patch.settled && patch.payout !== undefined && patch.gameState !== undefined) {
    return {
      ...item,
      phase: patch.phase,
      phaseName: phaseName(patch.phase),
      stake: patch.stake ?? item.stake,
      payout: patch.payout,
      isSettled: true,
      settledAt: item.settledAt ?? patch.settledAt,
      lastEventTimestamp: patch.settledAt ?? item.lastEventTimestamp,
      raw: {
        ...item.raw,
        gameState: patch.gameState,
        randomness: item.raw.randomness ?? patch.randomness,
        requestId: item.raw.requestId ?? patch.randomnessRequestId,
        settleTransactionHash: item.raw.settleTransactionHash ?? patch.settleTransactionHash,
      },
    };
  }

  let merged = item;
  if (patch.phase !== undefined && !isTerminalPhase(patch.phase)) {
    merged = {
      ...merged,
      phase: patch.phase,
      phaseName: phaseName(patch.phase),
      raw: { ...merged.raw, gameState: patch.gameState ?? merged.raw.gameState },
    };
  }
  if (patch.stake !== undefined) {
    merged = { ...merged, stake: patch.stake };
  }
  if (patch.randomness !== undefined && merged.raw.randomness === undefined) {
    merged = { ...merged, raw: { ...merged.raw, randomness: patch.randomness } };
  }
  return merged;
}

function rowRecordedFulfillment(row: CasinoSessionRow, nonce: string): boolean {
  return (
    row.randomnessRequests?.some(request => request.nonce === nonce && request.fulfilled) ??
    row.randomnessFulfilled ??
    false
  );
}

/** Drops patches the indexed feed has caught up with, keeping the map bounded. */
export function pruneFlashblockPatches(
  patches: FlashblockSessionPatches,
  rows: CasinoSessionRow[],
): FlashblockSessionPatches {
  const rowsById = new Map(rows.map(row => [row.sessionId, row]));
  const stale = Object.values(patches).filter(patch => {
    const row = rowsById.get(patch.sessionId);
    if (!row) return false;
    if (patch.step !== undefined && (row.step ?? -1) < patch.step) return false;
    if (patch.stakeStep !== undefined && (row.step ?? -1) < patch.stakeStep) return false;
    if (patch.settled && row.status !== 'settled' && !isTerminalPhase(row.phase)) return false;
    if (patch.fulfilledNonce !== undefined && !rowRecordedFulfillment(row, patch.fulfilledNonce)) {
      return false;
    }
    return true;
  });
  if (stale.length === 0) return patches;

  const next = { ...patches };
  for (const patch of stale) delete next[patch.sessionId];
  return next;
}
