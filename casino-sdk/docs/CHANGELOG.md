# Changelog

Versions use `YYYY.MM.DD-N`, where `N` increments when multiple SDK changes ship on the same day.

## 2026.08.30-1

### Added

- **`sessions.items[].stake`** in `HostSnapshotV1`: the session's total escrowed stake — the
  wager plus mid-session increases (e.g. a blackjack double/split), sourced from the
  `CasinoSessionEscrowUpdated` event. Updates flow through the flashblock layer, so an increase
  reaches the snapshot without waiting for the indexed feed. Games no longer need to
  reconstruct total escrow from their own `gameState`.

### Compatibility

- The field is optional — feature-detect it. It is absent on hosts that predate this release
  and on sessions from before `CasinoSessionEscrowUpdated` existed; fall back to `wager` (or
  your own reconstruction). On the live platform it stays absent until the facet upgrade that
  emits the event ships; the simulator publishes it already.

## 2026.08.29-1

### Added

- **Forfeit cash-out quote — `ICasinoGameV2.quoteForfeitPayout(ctx)`.** New view on the game
  interface returning the session's current cash-out value (stake + accrued winnings) decoded
  from `ctx.gameState`. When a session is abandoned past `actionDeadlineBlock`, forfeiture now
  pays the player `min(quote, escrowedStake + reservedProfit)` **minus a 10% cut**
  (`FORFEIT_WINNINGS_CUT_BPS = 1000`) instead of confiscating the whole stake. The facet calls
  it defensively (gas-capped `staticcall`, exactly 32 return bytes); any revert, malformed
  return, or absence of the method pays `0` — the pre-change behavior.
- **Who should quote:** only games with a true anytime cash-out whose value is fully determined
  by already-revealed state (mines-style). Games whose mid-round value depends on unresolved
  randomness or hidden state (blackjack-style) **must return `0`** — any concrete quote there is
  an adverse-selection exploit (players abandon exactly when their real continuation value is
  below the quote). See `CHAIN_WTF_CASINO_GAMES.md` § `quoteForfeitPayout` semantics.
- The simulator's `LocalCasinoHost` mirrors the facet logic, so the forfeit payout path is
  testable locally.

### Compatibility

- Backwards compatible: already-deployed games lack the method and keep paying `0` on forfeit.
  The method is part of `ICasinoGameV2`, so newly compiled games must implement it — returning
  `0` unconditionally is a valid implementation (and the required one for blackjack-style
  games). On-chain activation on the live platform awaits the facet upgrade; the simulator
  enforces the new behavior already.

## 2026.08.08-1

### Added

- **Live platform bet limits.** The Chain.wtf host (and the simulator) now populate the
  snapshot's **`casino`** block on every refresh: `availableLiquidity`, `maxBetRiskBps`,
  `maxAllowedReservedProfit` (the per-bet reserved-profit cap `openSession` enforces via
  `CasinoGameFacet__BetRiskExceedsLimit`), and the new **`casino.maxBetAmount`** — the absolute
  per-game wager ceiling when the platform configures one (unset or `'0'` = none).
- **`computeMaxWager(snapshot, { maxMultiplierX })`** guest helper (exported from the package
  root and `./guest`): converts the `casino` block into the largest wager the facet accepts for
  a game whose worst-case payout is `wager * maxMultiplierX`, accounting for `maxBetAmount`.
  Rounds conservatively (never returns a wager the facet would still reject) and returns
  `undefined` on hosts that don't publish limits. Use it to clamp bet inputs so players can't
  submit bets the chain will bounce; games with `gameData`-dependent multipliers should pass the
  multiplier of the current selection, or invert their exact `quoteCaps` math against
  `maxAllowedReservedProfit` (the bundled coinflip example shows both the exact gate and the
  helper-driven "Max" clamp).

### Compatibility

- Additive and optional — existing games keep working. An absent `casino` block means "limits
  unknown" (older host), not "unlimited".

## 2026.08.03-1

### Added

- **`simulator/`** — a fully standalone local test setup, needing nothing outside the SDK
  package. The package is now an npm workspace: one `npm install` at the SDK root covers the
  simulator, the bundled VRF node and the example game, and one `npm start` runs the whole
  local stack (chain + VRF node + casino deployment + harness + example). Individually,
  `npm run local-node` boots a chain (spawns anvil if none is running), deploys the real
  Verify Network VRF router + fulfilling node (via the bundled `local-verify-network`), and
  deploys a minimal casino: a freely mintable test token, `LocalCasinoHost` — a stand-in for the
  production `CasinoGameFacet` that runs the full `ICasinoGameV2` lifecycle and emits
  byte-identical events — and the real `CoinflipGame` contract (vendored compiled artifact) so
  the bundled example works out of the box. `npm run dev` starts the harness (Vite + React +
  Tailwind): it mounts any game iframe by URL and drives it through the same bridge as the
  Chain.wtf host, replicating the production host's behavior so games face the real integration
  quirks: optimistic `pending:` session rows, a near-instant flashblock push layer plus a lagged
  (tunable) indexed session feed, atomic settled flips with monotonic results, the game-steered
  balance ledger, and the stuck-randomness cancel path. The collapsible setup panel can also
  force `wallet.status` to exercise non-ready game states. See `simulator/README.md`.

### Compatibility

- Tooling only — no bridge/type changes. `getRandomnessVerification` is not implemented by the
  harness (the call rejects, as it may on any host that doesn't support it).

## 2026.07.26-1

### Added

- Added transaction hashes to session items so games can render real block-explorer `/tx/` links
  instead of falling back to the game contract's address page:
  - **`raw.openTransactionHash`** — the transaction that opened the session (the bet). The
    Chain.wtf host populates it on the optimistic row as soon as the relayer confirms, so it is
    available mid-round, before the indexer projection catches up.
  - **`raw.settleTransactionHash`** — the transaction that settled the session; absent until
    settled.
  - **`raw.randomnessRequests[].transactionHash`** — the VRF fulfillment transaction, per request;
    absent until that request is fulfilled. Because the `getRandomnessVerification` result extends
    the request shape, the same hash also appears on each verification entry.
- Explorer links prove a transaction exists, not that the randomness is fair — keep the client-side
  `getRandomnessVerification` verdict as the primary fairness signal and treat `/tx/` links as
  secondary. See `RANDOMNESS_VERIFICATION.md`.

### Compatibility

- Additive and optional: older hosts omit all three fields, and sessions projected before this
  version have no hashes (only a re-indexed environment backfills them). Keep an address-link (or
  no-link) fallback when a hash is absent.

## 2026.07.20-1

### Added

- Added **`raw.randomnessRequests`** to session items — every VRF request of the session in
  request order (`{ nonce, requestId, randomness?, fulfilled }`). Multi-step games (blackjack,
  pvp-dice) see one entry per step; single-shot games see exactly one. `raw.randomness` is now
  populated with the first fulfilled word.
- Added optional **`HostApiV1.getRandomnessVerification({ sessionId })`** — the host reads the
  ECVRF fulfillment artifacts from the Verify Network router and verifies them client-side
  (proof, output, EIP-712 enclave signature, signer identity). Returns per-request verdicts plus
  the raw artifacts so the result can be re-verified independently. See
  `RANDOMNESS_VERIFICATION.md` for the full contract and rendering rules.

### Compatibility

- Additive and optional: feature-detect `host.getRandomnessVerification` before calling; older
  hosts also omit `raw.randomnessRequests`. On environments without Verify Network (local dev)
  the method resolves with `supported: false`.

## 2026.07.19-1

### Added

- Added optional **`HostSnapshotV1.ui.viewport.availableHeight`** — the height in px from the top
  of the game's iframe to the bottom edge of the visible screen, before the user scrolls. Games
  that want their primary action (e.g. the bet button) to land exactly at the screen edge should
  size the content above it to `availableHeight` minus the action's own height. The value is
  measured against the small viewport (`svh` semantics), so it stays stable while scrolling
  collapses mobile browser chrome and only changes on real resizes or orientation changes.
- CSS viewport units cannot replace this value: the host grows the iframe to fit the game's
  reported content height, so inside the iframe `100vh` equals the full content height, not the
  visible screen.

### Compatibility

- Additive and optional: games running against older hosts simply receive no `ui.viewport` and
  should fall back to their existing layout.

## 2026.07.18-1

### Added

- Added optional **`HostSnapshotV1.token.iconUrl`** — an absolute URL of the wager token's icon so
  games can render it next to balances and wagers.

### Compatibility

- Additive and optional: games running against older hosts simply receive no `iconUrl` and should
  fall back to a text symbol.

## 2026.07.03-1

### Added

- Added optional **`HostApiV1.reportContentSize({ minHeight })`** so casino iframe games can report
  their current required content height to the host after the bridge connects.
- Added **`reportGameContentSize(hostApi)`** and **`observeGameContentSize(hostApi)`** helpers in
  `@chain/casino-sdk/guest`. Games can use the observer to report initial height and subsequent
  layout changes without wiring their own `ResizeObserver`.

### Changed

- Removed static **`presentation.minHeight`** from casino game manifest validation and examples.
  Height is now a runtime concern reported by the child iframe when `capabilities.resize` is
  supported.

### Compatibility

- Dynamic sizing is additive: older games that do not call `reportContentSize` continue to render
  using the host's existing frame fallback.
- `reportContentSize` is optional on the host API so games can safely run against older hosts by
  checking for the method or using `observeGameContentSize`, which no-ops when unsupported.

## 2026.07.02-1

### Added

- **`HostApiV1.revealOutcome({ sessionId })`** (required) — games **must** call this when their
  result presentation has finished. Sessions settle on-chain long before a result animation
  completes (bonus buys can run past a minute), so from the moment a bet is placed until the
  game reveals the outcome, the Chain.wtf host **clamps its balance displays** (navbar, vault
  modal, and the `balances.smartVaultBalance` pushed in the snapshot): the balance may move down
  (wager debit, extra escrow pulls) but never up. Guarding from bet placement — rather than
  subtracting the payout once it is known — means even a settlement that lands on-chain within a
  block can never flash the result. This is the reverse of an optimistic update: the payout is
  final, only its display is delayed. The guard exists only while the game is mounted —
  refreshing the page or navigating away from the game shows the real balance immediately.
- Only **credits** are withheld: the wager debit still shows the moment a session opens, and a
  lost session moves no balance at settlement (the host releases the guard itself on a lost
  round), so games only need to reveal after wins — calling it after losses is a harmless no-op.

### Breaking

- `revealOutcome` is a **mandatory** part of the game contract: a game that never calls it after
  a win leaves the host's displayed balance stale until the player leaves or reloads the game
  page. Update existing games to call `hostApi.revealOutcome({ sessionId })` at the end of their
  win presentation.

## 2026.06.18-1

### Added

- **`CasinoGameFacet` events now carry opaque game bytes**, so hosts can populate
  `HostSnapshotV1.sessions.items[].raw` from the session indexer without supplementary on-chain
  reads:
  - `CasinoSessionOpened` — added `bytes gameData` (the wager-time payload passed to
    `openSession`).
  - `CasinoSessionPhaseAdvanced` — added `bytes gameState` (post-step opaque state after each
    facet transition, including the first step after open).
  - `CasinoSessionSettled` — added `bytes gameState` (final opaque state at settlement).
- Documented that the **casino_sessions projection** ingests these fields and exposes them on each
  session row; the Chain.wtf host maps them to `raw.gameData` / `raw.gameState` in the Penpal
  snapshot pushed via `guestApi.setState`.

### Changed

- **Host snapshot freshness:** integrators should treat indexer session rows as the source of truth
  for `raw.gameData` and `raw.gameState`. On-chain `getSession(sessionId)` is optional for
  recovery or debugging — it is no longer required on every phase advance to keep the iframe in
  sync.

### Compatibility

- The new event fields are additive. Indexers and hosts that already merge projection rows into
  `HostSnapshotV1` gain automatic opaque-state updates; games that decode `raw.gameState` from the
  snapshot require no bridge API changes.
