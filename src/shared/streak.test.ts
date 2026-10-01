import { describe, expect, it } from 'vitest';

import {
  availableLinks,
  CARD_ACCEPT_LIMIT,
  CARD_COUNT,
  MAX_HISTORY_CARDS,
  cardFromRandomness,
  cardColor,
  cardRank,
  cardSuit,
  cashoutPayout,
  cashoutMultiplier,
  decodeActionData,
  decodeGameData,
  decodeGameState,
  encodeActionData,
  encodeGameData,
  encodeGameState,
  isLinkAvailable,
  isLinkSuccessful,
  linkFactor,
  nextOddsProduct,
  packCardHistory,
  packLinkHistory,
  RTP_BPS,
  unpackCardHistory,
  unpackLinkHistory,
  VRF_WORD_BYTES,
  type Link,
} from './streak';

describe('card encoding', () => {
  it('maps canonical card ids to their suit, color, and rank', () => {
    expect({ suit: cardSuit(0), color: cardColor(0), rank: cardRank(0) }).toEqual({
      suit: 0,
      color: 0,
      rank: 0,
    });
    expect({ suit: cardSuit(25), color: cardColor(25), rank: cardRank(25) }).toEqual({
      suit: 1,
      color: 1,
      rank: 12,
    });
    expect({ suit: cardSuit(38), color: cardColor(38), rank: cardRank(38) }).toEqual({
      suit: 2,
      color: 1,
      rank: 12,
    });
    expect({ suit: cardSuit(51), color: cardColor(51), rank: cardRank(51) }).toEqual({
      suit: 3,
      color: 0,
      rank: 12,
    });
  });
});

describe('link outcomes', () => {
  it.each([
    ['color', 26],
    ['suit', 13],
    ['rank', 4],
  ] as const)('gives every anchor exactly %s matching cards', (link, expectedMatches) => {
    for (let anchor = 0; anchor < CARD_COUNT; anchor += 1) {
      const matches = Array.from({ length: CARD_COUNT }, (_, drawn) => drawn).filter(drawn =>
        isLinkSuccessful(anchor, drawn, link as Link),
      );

      expect(matches).toHaveLength(expectedMatches);
    }
  });
});

describe('route building and payouts', () => {
  it('uses the documented factors and availability boundary', () => {
    expect(linkFactor('color')).toBe(2);
    expect(linkFactor('suit')).toBe(4);
    expect(linkFactor('rank')).toBe(13);

    expect(availableLinks(1)).toEqual(['color', 'suit', 'rank']);
    expect(availableLinks(64)).toEqual(['color', 'suit']);
    expect(availableLinks(128)).toEqual(['color']);
    expect(availableLinks(169)).toEqual([]);
    expect(isLinkAvailable(208, 'color')).toBe(false);
  });

  it('enumerates every reachable odds product without exceeding 256', () => {
    const discovered = new Set([1]);
    const pending = [1];

    while (pending.length > 0) {
      const current = pending.shift()!;
      for (const link of availableLinks(current)) {
        const next = nextOddsProduct(current, link);
        if (!discovered.has(next)) {
          discovered.add(next);
          pending.push(next);
        }
      }
    }

    expect([...discovered].sort((left, right) => left - right)).toEqual([
      1, 2, 4, 8, 13, 16, 26, 32, 52, 64, 104, 128, 169, 208, 256,
    ]);
  });

  it('returns the exact documented cash-out values at 96% RTP', () => {
    const wager = 10_000n;

    expect(cashoutPayout(wager, 2)).toBe(19_200n);
    expect(cashoutPayout(wager, 4)).toBe(38_400n);
    expect(cashoutPayout(wager, 13)).toBe(124_800n);
    expect(cashoutPayout(wager, 104)).toBe(998_400n);
    expect(cashoutPayout(wager, 169)).toBe(1_622_400n);
    expect(cashoutPayout(wager, 256)).toBe(2_457_600n);

    for (const oddsProduct of [2, 4, 8, 13, 16, 26, 32, 52, 64, 104, 128, 169, 208, 256]) {
      expect(cashoutPayout(wager, oddsProduct) / BigInt(oddsProduct)).toBe(RTP_BPS);
    }
  });

  it('uses the same RTP constants for display multipliers', () => {
    expect(cashoutMultiplier(2)).toBe(1.92);
    expect(cashoutMultiplier(13)).toBe(12.48);
    expect(cashoutMultiplier(256)).toBe(245.76);
  });
});

describe('VRF card derivation', () => {
  it('maps every accepted byte evenly across the card space', () => {
    const counts = Array.from({ length: CARD_COUNT }, () => 0);

    for (let candidate = 0; candidate < CARD_ACCEPT_LIMIT; candidate += 1) {
      const seed = new Uint8Array(VRF_WORD_BYTES);
      seed[0] = candidate;
      counts[cardFromRandomness(seed)] += 1;
    }

    expect(counts).toEqual(
      Array.from({ length: CARD_COUNT }, () => CARD_ACCEPT_LIMIT / CARD_COUNT),
    );
  });

  it('skips rejected bytes and expands an exhausted seed with Keccak', () => {
    const seedWithLaterCandidate = new Uint8Array(VRF_WORD_BYTES).fill(255);
    seedWithLaterCandidate[1] = CARD_ACCEPT_LIMIT - 1;
    expect(cardFromRandomness(seedWithLaterCandidate)).toBe(51);

    const fullyRejectedSeed = new Uint8Array(VRF_WORD_BYTES).fill(255);
    expect(cardFromRandomness(fullyRejectedSeed)).toBe(13);
  });
});

describe('contract ABI boundary', () => {
  it('encodes and decodes canonical game and action data', () => {
    const gameData = encodeGameData({ anchorCard: 51, firstLink: 'rank' });
    expect(gameData).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000033' +
        '0000000000000000000000000000000000000000000000000000000000000002',
    );
    expect(decodeGameData(gameData)).toEqual({ anchorCard: 51, firstLink: 'rank' });

    const cashout = encodeActionData({ kind: 'cashout' });
    expect(decodeActionData(cashout)).toEqual({ kind: 'cashout' });

    const continuation = encodeActionData({ kind: 'continue', link: 'suit' });
    expect(continuation).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000001' +
        '0000000000000000000000000000000000000000000000000000000000000001',
    );
    expect(decodeActionData(continuation)).toEqual({ kind: 'continue', link: 'suit' });
  });

  it('packs card and link histories and round-trips game state', () => {
    const cards = [0, 39, 40, 14];
    expect(packCardHistory(cards)).toBe(3_836_352n);
    expect(unpackCardHistory(3_836_352n, 4)).toEqual(cards);

    const links = ['color', 'suit', 'rank'] as const;
    expect(packLinkHistory(links)).toBe(36);
    expect(unpackLinkHistory(36, 3)).toEqual(links);

    const state = {
      anchorCard: 14,
      pendingLink: null,
      oddsProduct: 104,
      streakLength: 3,
      packedCardHistory: 3_836_352n,
      packedLinkHistory: 36,
      cardCount: 4,
    } as const;

    expect(decodeGameState(encodeGameState(state))).toEqual(state);

    const initialState = {
      anchorCard: 0,
      pendingLink: 'rank',
      oddsProduct: 1,
      streakLength: 0,
      packedCardHistory: packCardHistory([0]),
      packedLinkHistory: 0,
      cardCount: 1,
    } as const;
    expect(decodeGameState(encodeGameState(initialState))).toEqual(initialState);

    const losingState = {
      anchorCard: 13,
      pendingLink: null,
      oddsProduct: 1,
      streakLength: 0,
      packedCardHistory: packCardHistory([0, 13]),
      packedLinkHistory: packLinkHistory(['color']),
      cardCount: 2,
    } as const;
    expect(decodeGameState(encodeGameState(losingState))).toEqual(losingState);
  });

  it('rejects non-canonical encoded values', () => {
    const invalidLinkGameData = (
      '0x0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000003'
    ) as `0x${string}`;

    expect(() => decodeGameData(invalidLinkGameData)).toThrow(/link/i);
    expect(() => decodeGameData(`${encodeGameData({ anchorCard: 0, firstLink: 'color' })}${'00'.repeat(32)}`)).toThrow(
      /length/i,
    );
    expect(() => packCardHistory(Array.from({ length: MAX_HISTORY_CARDS + 1 }, () => 0))).toThrow(/more than/i);

    const inconsistentState = {
      anchorCard: 14,
      pendingLink: null,
      oddsProduct: 128,
      streakLength: 3,
      packedCardHistory: 3_836_352n,
      packedLinkHistory: 36,
      cardCount: 4,
    } as const;
    expect(() => encodeGameState(inconsistentState)).toThrow(/odds product/i);

    const falseSuccessState = {
      anchorCard: 13,
      pendingLink: null,
      oddsProduct: 2,
      streakLength: 1,
      packedCardHistory: packCardHistory([0, 13]),
      packedLinkHistory: packLinkHistory(['color']),
      cardCount: 2,
    } as const;
    expect(() => encodeGameState(falseSuccessState)).toThrow(/outcome/i);
  });
});
