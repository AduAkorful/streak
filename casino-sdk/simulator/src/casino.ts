// Session types, phase helpers and calldata encoding shared with the
// production host.
import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex } from 'viem';
import type { TransactionReceipt } from 'viem';

import { casinoGameFacetAbi, erc20Abi } from './casino-abi';

export const EMPTY_HEX = '0x' as const;

export function toAddress(value: string): Address {
  return getAddress(value.toLowerCase());
}

// `SessionPhase` mirrors the on-chain enum (see ICasinoGameV2.sol).
export const SESSION_PHASE_NAMES = [
  'NONE',
  'WAITING_RANDOMNESS',
  'WAITING_PLAYER_ACTION',
  'SETTLED',
  'FORFEITED',
  'CANCELLED',
] as const;

export type SessionPhaseName = (typeof SESSION_PHASE_NAMES)[number];

export function phaseName(phase: number | undefined): SessionPhaseName | undefined {
  if (phase === undefined) return undefined;
  return SESSION_PHASE_NAMES[phase];
}

const TERMINAL_PHASES: ReadonlySet<SessionPhaseName> = new Set([
  'SETTLED',
  'FORFEITED',
  'CANCELLED',
]);

export function isTerminalPhase(phase: number | undefined): boolean {
  const name = phaseName(phase);
  return name !== undefined && TERMINAL_PHASES.has(name);
}

export type GameIntegration = {
  slug: string;
  gameAddress: Address;
  gameName: string;
  name: string;
  description?: string;
  image?: string;
  url?: string;
};

/** The indexed session row shape the host builds snapshot items from. */
export type CasinoSessionRow = {
  sessionId: string;
  chainId: number;
  game: string;
  gameName: string;
  player: string;
  vault: string;
  token: string;
  tokenDecimals: number;
  wager: string;
  /** Total escrowed stake (wager + mid-session increases like blackjack doubles); absent on legacy sessions. */
  stake?: string;
  maxEscrowStake: string;
  maxReservedProfit: string;
  gameData?: string;
  gameState?: string;
  status: 'open' | 'settled';
  phase: number;
  step?: number;
  actionDeadlineBlock?: string;
  randomnessDeadlineBlock?: string;
  randomnessRequestId?: string;
  randomnessFulfilled?: boolean;
  randomnessRequests?: Array<{
    nonce: string;
    requestId: string;
    randomness?: string;
    fulfilled: boolean;
    transactionHash?: string;
  }>;
  payout?: string;
  openedAt: number;
  settledAt?: number;
  openTransactionHash?: string;
  settleTransactionHash?: string;
};

export type BatchAction = { target: Address; value: bigint; data: Hex };

export function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
}

export function encodeOpenSession(input: {
  game: Address;
  vault: Address;
  wager: bigint;
  gameData: Hex;
  randomnessRequestData: Hex;
}): Hex {
  return encodeFunctionData({
    abi: casinoGameFacetAbi,
    functionName: 'openSession',
    args: [input.game, input.vault, input.wager, input.gameData, input.randomnessRequestData],
  });
}

export function encodeSubmitAction(input: {
  sessionId: bigint;
  actionData: Hex;
  randomnessRequestData: Hex;
}): Hex {
  return encodeFunctionData({
    abi: casinoGameFacetAbi,
    functionName: 'submitAction',
    args: [input.sessionId, input.actionData, input.randomnessRequestData],
  });
}

export function encodeCancelStuckRandomness(sessionId: bigint): Hex {
  return encodeFunctionData({
    abi: casinoGameFacetAbi,
    functionName: 'cancelStuckRandomness',
    args: [sessionId],
  });
}

/** Pulls the new `sessionId` out of the `CasinoSessionOpened` log of a receipt. */
export function parseOpenedSessionId(receipt: TransactionReceipt): bigint {
  const logs = parseEventLogs({
    abi: casinoGameFacetAbi,
    eventName: 'CasinoSessionOpened',
    logs: receipt.logs,
  });
  const sessionId = logs[0]?.args.sessionId;
  if (sessionId === undefined) {
    throw new Error('CasinoSessionOpened event missing from the receipt.');
  }
  return sessionId;
}
