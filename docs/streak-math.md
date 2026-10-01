# Streak Math And Randomness Specification

## 1. Constants

```text
CARD_COUNT       = 52
SUIT_COUNT       = 4
RANK_COUNT       = 13
RTP_BPS          = 9600
BASIS_POINTS     = 10000
MAX_ODDS_PRODUCT = 256
WAD              = 1e18
```

All contract calculations use integers. Floating-point notation in this document is explanatory
only.

## 2. Card Encoding

A card is an integer in `[0, 51]`.

```text
suit(card) = floor(card / 13)
rank(card) = card % 13
```

Suit encoding:

| Value | Suit | Color |
|---:|---|---|
| 0 | Clubs | Black |
| 1 | Diamonds | Red |
| 2 | Hearts | Red |
| 3 | Spades | Black |

Rank encoding:

| Value | Rank |
|---:|---|
| 0 | Ace |
| 1-9 | 2-10 |
| 10 | Jack |
| 11 | Queen |
| 12 | King |

Color can be derived from the suit:

```text
color(card) = RED   when suit(card) is 1 or 2
color(card) = BLACK when suit(card) is 0 or 3
```

Every anchor has exactly:

- 26 matching-color cards
- 13 matching-suit cards
- 4 matching-rank cards

This remains true because every wagered card is drawn independently from the complete 52-card
shoe.

## 3. Link Predicates

The player commits one link before randomness is requested.

```text
Color succeeds when color(anchor) == color(drawn)
Suit  succeeds when suit(anchor)  == suit(drawn)
Rank  succeeds when rank(anchor)  == rank(drawn)
```

| Link | Successful cards | Probability | Odds factor |
|---|---:|---:|---:|
| Color | 26 | `26/52 = 1/2` | 2 |
| Suit | 13 | `13/52 = 1/4` | 4 |
| Rank | 4 | `4/52 = 1/13` | 13 |

Predicates overlap. For example, the exact same card satisfies all three links. Only the
precommitted link is evaluated and paid.

## 4. Route Probability

`oddsProduct` starts at `1`. After each successful link it is multiplied by that link's odds
factor.

For route factors `f[0] ... f[n-1]`:

```text
oddsProduct = product(f[i])
```

Because each wagered draw is independent:

```text
routeSuccessProbability = product(1 / f[i])
                        = 1 / oddsProduct
```

A next link is legal only when:

```text
oddsProduct * nextFactor <= 256
```

Suit contributes a factor of `4`, which is equivalent to two powers of `2`. Therefore every
reachable product has the form:

```text
2^a * 13^b <= 256
```

The complete reachable set is:

```text
1, 2, 4, 8, 13, 16, 26, 32, 52, 64, 104, 128, 169, 208, 256
```

`1` is the pre-success initial state and has no cash-out value.

## 5. Cash-Out Payout

For wager `w` and successful route product `q`:

```text
payout(w, q) = floor(w * RTP_BPS * q / BASIS_POINTS)
             = floor(w * 9600 * q / 10000)
```

The payout includes the original wager.

Before token-unit floor rounding:

```text
expectedPayout
  = routeSuccessProbability * payout
  = (1 / q) * (w * 0.96 * q)
  = 0.96 * w
```

Thus every legal route and cash-out point has 96% theoretical RTP. The player does not pay an
additional house edge for choosing a longer route.

## 6. Reachable Multipliers

| Odds product | Route probability | Multiplier |
|---:|---:|---:|
| 2 | `1/2` | `1.92x` |
| 4 | `1/4` | `3.84x` |
| 8 | `1/8` | `7.68x` |
| 13 | `1/13` | `12.48x` |
| 16 | `1/16` | `15.36x` |
| 26 | `1/26` | `24.96x` |
| 32 | `1/32` | `30.72x` |
| 52 | `1/52` | `49.92x` |
| 64 | `1/64` | `61.44x` |
| 104 | `1/104` | `99.84x` |
| 128 | `1/128` | `122.88x` |
| 169 | `1/169` | `162.24x` |
| 208 | `1/208` | `199.68x` |
| 256 | `1/256` | `245.76x` |

Examples:

```text
Color -> Suit -> Rank
q = 2 * 4 * 13 = 104
p = 1 / 104
cash-out = 99.84x

Rank -> Rank
q = 13 * 13 = 169
p = 1 / 169
cash-out = 162.24x
```

At `q = 169`, even the smallest next factor would produce `338`, so the session automatically
cashes out. The same rule applies to any successful state with no legal next link.

## 7. Integer Rounding

The Solidity implementation should calculate payouts with full-precision multiplication and
floor division, equivalent to:

```text
mulDiv(wager, RTP_BPS * oddsProduct, BASIS_POINTS)
```

The maximum scalar is:

```text
9600 * 256 = 2_457_600
```

Floor rounding can reduce actual RTP by less than one smallest token unit per payout. It can never
raise RTP above 96%.

The TypeScript mirror must use `bigint` and the same operation order:

```text
(wager * 9600n * oddsProduct) / 10000n
```

The final minimum wager should be selected with the production token decimals so rounding is
negligible in the displayed denomination.

## 8. Unbiased VRF-To-Card Mapping

The random domain of one byte has 256 values. Since `256` is not divisible by `52`, raw
`byte % 52` is biased.

The largest multiple of 52 below 256 is:

```text
floor(256 / 52) * 52 = 4 * 52 = 208
```

The mapping algorithm is:

1. Read bytes from the VRF `bytes32` word from index `0` through `31`.
2. Reject every byte `>= 208`.
3. For the first accepted byte, return `byte % 52`.
4. If all 32 bytes are rejected, replace the seed with the Keccak-256 hash of the raw 32-byte
   seed and continue from byte index `0`.

Each card receives exactly four accepted byte values, so every card has equal probability.

### Solidity Reference Shape

```solidity
function _cardFromRandomness(bytes32 seed) internal pure returns (uint8 card) {
    uint256 index;

    while (true) {
        if (index == 32) {
            seed = keccak256(abi.encodePacked(seed));
            index = 0;
        }

        uint8 candidate = uint8(seed[index]);
        index++;

        if (candidate < 208) {
            return candidate % 52;
        }
    }
}
```

### TypeScript Reference Shape

```typescript
function cardFromRandomness(randomness: Uint8Array): number {
  let seed = randomness;
  let index = 0;

  while (true) {
    if (index === seed.length) {
      seed = hexToBytes(keccak256(seed));
      index = 0;
    }

    const candidate = seed[index];
    index += 1;

    if (candidate < 208) return candidate % 52;
  }
}
```

Both implementations must hash the same raw bytes and preserve byte order.

## 9. Risk Parameters

For wager `w`:

```text
maxPayout                = floor(w * 9600 * 256 / 10000)
maxEscrowStake           = w
maxReservedProfit        = maxPayout - w
topPayoutProbability     = 1 / 256
probabilityWad           = 1e18 / 256
                         = 3_906_250_000_000_000
expectedPayout           = floor(w * 9600 / 10000)
subJackpotVarianceScaled = 0
```

The maximum multiplier is above the SDK's default `100x` heavy-tail multiplier threshold, but the
top probability is `0.390625%`, above the default `0.1%` heavy-tail probability threshold. Both
conditions are required by the documented default classifier, so this model is not classified as
heavy-tail under those defaults.

## 10. Required Invariants

The implementation and tests must preserve these invariants:

1. Every accepted card value is in `[0, 51]`.
2. Random mapping rejects bytes `208` through `255`.
3. A prediction is committed before its randomness is requested.
4. `oddsProduct` is always one of the reachable products and never exceeds `256`.
5. A successful link multiplies `oddsProduct` by exactly its documented factor.
6. A failed link settles at `0`.
7. Cash-out payout is derived only from wager and the successful `oddsProduct`.
8. Maximum payout never exceeds the amount returned by the risk quotes.
9. TypeScript and Solidity encode cards, links, routes, and payouts identically.
10. No client preview substitutes for contract-authoritative settlement.
