import { describe, expect, it } from 'vite-plus/test';

import { computeMaxWager } from './bet-limits';

const snapshotWith = (casino: object) => ({ casino }) as Parameters<typeof computeMaxWager>[0];

describe('computeMaxWager', () => {
  it('returns undefined without a casino block', () => {
    expect(computeMaxWager(null, { maxMultiplierX: 5000 })).toBeUndefined();
    expect(computeMaxWager({}, { maxMultiplierX: 5000 })).toBeUndefined();
  });

  it('derives the wager from the reserved-profit cap for an integer multiplier', () => {
    const snapshot = snapshotWith({
      maxAllowedReservedProfit: (4999n * 100n * 10n ** 18n).toString(),
    });
    expect(computeMaxWager(snapshot, { maxMultiplierX: 5000 })).toBe(100n * 10n ** 18n);
  });

  it('never returns a wager whose reserved profit exceeds the cap', () => {
    const cap = 123_456_789_123_456_789n;
    const snapshot = snapshotWith({ maxAllowedReservedProfit: cap.toString() });
    for (const maxMultiplierX of [1.42545, 1.98, 3.136, 5000]) {
      const wager = computeMaxWager(snapshot, { maxMultiplierX })!;
      const reservedProfit = (wager * BigInt(Math.ceil(maxMultiplierX * 10_000))) / 10_000n - wager;
      expect(reservedProfit <= cap).toBe(true);
    }
  });

  it('applies the absolute maxBetAmount ceiling', () => {
    const snapshot = snapshotWith({
      maxAllowedReservedProfit: (10_000n * 10n ** 18n).toString(),
      maxBetAmount: (50n * 10n ** 18n).toString(),
    });
    expect(computeMaxWager(snapshot, { maxMultiplierX: 2 })).toBe(50n * 10n ** 18n);
  });

  it('ignores a zero maxBetAmount', () => {
    const snapshot = snapshotWith({
      maxAllowedReservedProfit: (100n * 10n ** 18n).toString(),
      maxBetAmount: '0',
    });
    expect(computeMaxWager(snapshot, { maxMultiplierX: 2 })).toBe(100n * 10n ** 18n);
  });

  it('falls back to maxBetAmount when the multiplier reserves no profit', () => {
    const snapshot = snapshotWith({
      maxAllowedReservedProfit: (100n * 10n ** 18n).toString(),
      maxBetAmount: (25n * 10n ** 18n).toString(),
    });
    expect(computeMaxWager(snapshot, { maxMultiplierX: 1 })).toBe(25n * 10n ** 18n);
  });

  it('returns undefined when no limit applies', () => {
    expect(computeMaxWager(snapshotWith({}), { maxMultiplierX: 5000 })).toBeUndefined();
    expect(
      computeMaxWager(snapshotWith({ maxAllowedReservedProfit: '100' }), { maxMultiplierX: 1 }),
    ).toBeUndefined();
  });
});
