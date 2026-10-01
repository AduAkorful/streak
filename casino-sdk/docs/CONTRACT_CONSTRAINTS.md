# Smart contract constraints (`CasinoGameFacet` + `ICasinoGameV2`)

Summarized from `packages/evm/contracts/contracts/Casino/CasinoGameFacet.sol` and `CasinoRiskLib.sol`. Treat source files as authoritative if this doc drifts.

## Game interface

Your game **must** implement [`ICasinoGameV2`](./solidity/ICasinoGameV2.sol):

- **`quoteCaps(wager, gameData)`** — `maxEscrowStake >= wager` or `openSession` reverts. `maxReservedProfit` is used with per-session bet-risk limits (`maxBetRiskBps` vs vault liquidity).
- **`quoteRiskParams(wager, gameData)`** — Returns `maxPayout`, **`probabilityWad`** (1e18 = 100%), `expectedPayout`, `subJackpotVarianceScaled`.
  - `probabilityWad` must be **≤ 1e18** or `CasinoGameFacet__InvalidRiskProbability`.
  - For slots / jackpots: `probabilityWad` should reflect the **top-tier (jackpot) win probability** so the facet can apply the **tiered heavy-tail** reserve path (see `SLOTS_RISK_AND_RESERVES.md`).
  - `subJackpotVarianceScaled` is for precomputed sub-jackpot variance when stripping the jackpot tier (heavy-tail games); often `0` initially.
- **`onSessionStart` / `onPlayerAction` / `onRandomness`** — Pure/view step handlers; return `StepResult` with `nextPhase`, `requestRandomnessNow`, `escrowDelta`, `reservedProfitDelta`, `payout`, `outcome`, `newGameState`.
- **`quoteForfeitPayout(ctx)`** — Current cash-out value (stake + accrued winnings) derived from `ctx.gameState`; return `0` when nothing is cashable mid-round. When a session is forfeited after the action deadline the facet pays the player this quote (clamped to `escrowedStake + reservedProfit`) minus a 10% cut (`FORFEIT_WINNINGS_CUT_BPS = 1000`). The call is defensive (gas-capped staticcall, 32-byte return): if it reverts, returns malformed data, or the game predates this method, the forfeit pays `0`. Quote a real value only if your game has a true anytime cash-out fully determined by already-revealed state (mines-style); if mid-round value depends on unresolved randomness or hidden state (blackjack-style), return `0` — any quote there is an adverse-selection exploit against the vault (see `CHAIN_WTF_CASINO_GAMES.md`).
- **Unbiased d6 from `bytes32` randomness (MUST)** — If you map VRF/facet bytes to faces `1..6`, you **must** use rejection sampling (`byte < 252` then `(byte % 6) + 1`). **Do not** use raw `(randomness[i] % 6) + 1` on a byte — that is modulo-biased. See [`RANDOMNESS_DICE.md`](./RANDOMNESS_DICE.md) for canonical Solidity/TypeScript and agent checklist.

## Facet orchestration

- **Whitelist**: `CasinoGameFacet__GameNotWhitelisted` if the game address is not whitelisted (governance).
- **Vault**: Must be a protocol vault (`VaultManagerLib.isVault`); min bet checked.
- **Randomness provider** must be set on the facet or `CasinoGameFacet__RandomnessProviderNotSet`.
- **`openSession` flow**: Pulls wager from player, calls **`onSessionStart` twice** in practice — once as a **simulation** (`sessionId == 0`) before portfolio commit, then again with real session context (see facet code). Your `onSessionStart` must be **consistent and view-safe**.
- **Payout**: Facet enforces payout against risk snapshot / max payout (`CasinoGameFacet__InvalidPayout`).
- **Escrow / reserved profit**: Escrow increases may be restricted (`CasinoGameFacet__EscrowIncreaseNotAllowed`); caps enforced (`EscrowCapExceeded`, `ReservedProfitCapExceeded`).
- **Phases**: Invalid transitions revert (`CasinoGameFacet__InvalidStepTransition`). Example: you cannot request randomness from a terminal phase incorrectly.
- **Reentrancy**: All value-moving entrypoints (`openSession`, `submitAction`, `onRandomnessFulfilled`, `forfeitExpiredSession(s)`, `cancelStuckRandomness`) are `nonReentrant` (OpenZeppelin `ReentrancyGuardTransient`, a diamond-safe EIP-1153 guard), and settlement finalizes session state before any token transfer (checks-effects-interactions). Game step handlers are `view` (reached via `staticcall`), so a game contract cannot reenter.

## Default governance constants (facet)

These are **configurable** by `SECURITY_COUNCIL_ROLE` but defaults matter for understanding behavior:

| Constant                                | Default | Meaning (high level)                                                                                          |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_ACTION_TIMEOUT_BLOCKS`         | 43200   | Player must act before this block window or forfeit path applies (payout = 90% of `quoteForfeitPayout`).      |
| `DEFAULT_RANDOMNESS_TIMEOUT_BLOCKS`     | 150     | RNG fulfillment window before cancel / stuck handling.                                                        |
| `DEFAULT_MAX_BET_RISK_BPS`              | 100     | Bet risk vs available liquidity (basis points).                                                               |
| `DEFAULT_CONFIDENCE_MULTIPLIER_BPS`     | 372     | VaR multiplier (~3.72 for 99.99% in their model).                                                             |
| `DEFAULT_SAFETY_MULTIPLIER_BPS`         | 15000   | 1.5× safety on VaR leg.                                                                                       |
| `DEFAULT_MIN_RESERVE_RATIO_BPS`         | 1500    | Minimum reserve ratio.                                                                                        |
| `DEFAULT_HEAVY_TAIL_MULT_THRESHOLD`     | 100     | `maxPayout/wager > this` participates in heavy-tail check.                                                    |
| `DEFAULT_HEAVY_TAIL_PROB_THRESHOLD_WAD` | 1e15    | **0.1%** in WAD — jackpot probability below this triggers heavy-tail path together with multiplier threshold. |

Heavy-tail detection in library: `CasinoRiskLib.isHeavyTail(maxPayout, wager, probabilityWad, multiplierThreshold, probThresholdWad)`.

## Portfolio / insolvency

- `CasinoGameFacet__InsufficientPortfolioReserve` when the vault cannot satisfy committed portfolio reserve requirements for the new session.
- `CasinoGameFacet__InconsistentJackpotProbability` when heavy-tail jackpot stats don’t line up (game-specific invariants).

## Build

In this monorepo, contracts are built with **`pnpm build`** from `packages/evm/contracts` (not raw `hardhat compile` only) so postbuild steps run — see root `AGENTS.md`.
