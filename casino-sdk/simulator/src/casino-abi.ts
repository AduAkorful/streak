// The subset of the production CasinoGameFacet ABI the harness uses.
export const casinoSessionEventsAbi = [
  {
    type: 'event',
    anonymous: false,
    name: 'CasinoSessionOpened',
    inputs: [
      { type: 'uint256', name: 'sessionId', indexed: true },
      { type: 'address', name: 'game', indexed: true },
      { type: 'address', name: 'player', indexed: true },
      { type: 'address', name: 'vault', indexed: false },
      { type: 'address', name: 'token', indexed: false },
      { type: 'uint8', name: 'tokenDecimals', indexed: false },
      { type: 'uint256', name: 'wager', indexed: false },
      { type: 'uint256', name: 'maxEscrowStake', indexed: false },
      { type: 'uint256', name: 'maxReservedProfit', indexed: false },
      { type: 'string', name: 'gameName', indexed: false },
      { type: 'bytes', name: 'gameData', indexed: false },
    ],
  },
  {
    type: 'event',
    anonymous: false,
    name: 'CasinoSessionEscrowUpdated',
    inputs: [
      { type: 'uint256', name: 'sessionId', indexed: true },
      { type: 'uint32', name: 'step', indexed: true },
      { type: 'uint256', name: 'previousEscrowedStake', indexed: false },
      { type: 'uint256', name: 'escrowedStake', indexed: false },
    ],
  },
  {
    type: 'event',
    anonymous: false,
    name: 'CasinoSessionPhaseAdvanced',
    inputs: [
      { type: 'uint256', name: 'sessionId', indexed: true },
      { type: 'uint32', name: 'step', indexed: true },
      { type: 'uint8', name: 'phase', indexed: false },
      { type: 'uint256', name: 'actionDeadlineBlock', indexed: false },
      { type: 'uint256', name: 'randomnessDeadlineBlock', indexed: false },
      { type: 'bytes', name: 'gameState', indexed: false },
    ],
  },
  {
    type: 'event',
    anonymous: false,
    name: 'CasinoSessionRandomnessRequested',
    inputs: [
      { type: 'uint256', name: 'sessionId', indexed: true },
      { type: 'address', name: 'provider', indexed: true },
      { type: 'bytes32', name: 'requestId', indexed: true },
      { type: 'uint64', name: 'requestNonce', indexed: false },
      { type: 'uint256', name: 'randomnessDeadlineBlock', indexed: false },
    ],
  },
  {
    type: 'event',
    anonymous: false,
    name: 'CasinoSessionRandomnessFulfilled',
    inputs: [
      { type: 'uint256', name: 'sessionId', indexed: true },
      { type: 'address', name: 'provider', indexed: true },
      { type: 'bytes32', name: 'requestId', indexed: true },
      { type: 'uint64', name: 'requestNonce', indexed: false },
      { type: 'bytes32', name: 'randomness', indexed: false },
    ],
  },
  {
    type: 'event',
    anonymous: false,
    name: 'CasinoSessionSettled',
    inputs: [
      { type: 'uint256', name: 'sessionId', indexed: true },
      { type: 'address', name: 'game', indexed: true },
      { type: 'address', name: 'player', indexed: true },
      { type: 'uint8', name: 'phase', indexed: false },
      { type: 'uint256', name: 'payout', indexed: false },
      { type: 'string', name: 'gameName', indexed: false },
      { type: 'bytes', name: 'gameState', indexed: false },
    ],
  },
] as const;

export const casinoGameFacetAbi = [
  ...casinoSessionEventsAbi,
  {
    type: 'function',
    name: 'openSession',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'game' },
      { type: 'address', name: 'vault' },
      { type: 'uint256', name: 'wager' },
      { type: 'bytes', name: 'gameData' },
      { type: 'bytes', name: 'randomnessRequestData' },
    ],
    outputs: [
      { type: 'uint256', name: 'sessionId' },
      { type: 'bytes32', name: 'requestId' },
    ],
  },
  {
    type: 'function',
    name: 'submitAction',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256', name: 'sessionId' },
      { type: 'bytes', name: 'actionData' },
      { type: 'bytes', name: 'randomnessRequestData' },
    ],
    outputs: [{ type: 'bytes32', name: 'requestId' }],
  },
  {
    type: 'function',
    name: 'cancelStuckRandomness',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256', name: 'sessionId' }],
    outputs: [{ type: 'uint256', name: 'payout' }],
  },
] as const;

// Harness-only surface of LocalCasinoHost (not on the production facet).
export const localCasinoHostExtrasAbi = [
  {
    type: 'function',
    name: 'getGameName',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'game' }],
    outputs: [{ type: 'string', name: 'gameName' }],
  },
  {
    type: 'function',
    name: 'registerGame',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'game' },
      { type: 'string', name: 'gameName' },
    ],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'spender' },
      { type: 'uint256', name: 'amount' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;
