import {
  decodeAbiParameters,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  type Hex,
} from 'viem';

export const SUIT_COUNT = 4;
export const RANK_COUNT = 13;
export const CARD_COUNT = SUIT_COUNT * RANK_COUNT;
export const RTP_BPS = 9_600n;
export const BASIS_POINTS = 10_000n;
export const MAX_ODDS_PRODUCT = 256;
export const VRF_WORD_BYTES = 32;

export type CardColor = 0 | 1;
export type CardSuit = 0 | 1 | 2 | 3;
export type Link = 'color' | 'suit' | 'rank';
export type GameData = { anchorCard: number; firstLink: Link };
export type PlayerAction = { kind: 'cashout' } | { kind: 'continue'; link: Link };
export type GameState = {
  anchorCard: number;
  pendingLink: Link | null;
  oddsProduct: number;
  streakLength: number;
  packedCardHistory: bigint;
  packedLinkHistory: number;
  cardCount: number;
};

export const LINKS = ['color', 'suit', 'rank'] as const satisfies readonly Link[];

const LINK_FACTORS = {
  color: 2,
  suit: 4,
  rank: 13,
} as const satisfies Record<Link, number>;
const SUIT_COLORS = [0, 1, 1, 0] as const satisfies readonly CardColor[];
const RANDOM_BYTE_DOMAIN = 2 ** (Uint8Array.BYTES_PER_ELEMENT * 8);
export const CARD_ACCEPT_LIMIT = Math.floor(RANDOM_BYTE_DOMAIN / CARD_COUNT) * CARD_COUNT;
const CARD_BITS = Math.ceil(Math.log2(CARD_COUNT));
const CARD_MASK = (1n << BigInt(CARD_BITS)) - 1n;
const LINK_BITS = Math.ceil(Math.log2(LINKS.length + 1));
const LINK_MASK = (1 << LINK_BITS) - 1;
const LINK_NONE = LINKS.length;
const ACTION_CASHOUT = 0;
const ACTION_CONTINUE = 1;
const CASHOUT_LINK_CODE = LINKS.indexOf(LINKS[0]);
const ABI_WORD_BYTES = 32;
const UINT8_MAX = RANDOM_BYTE_DOMAIN - 1;
const UINT8_BITS = Uint8Array.BYTES_PER_ELEMENT * 8;
const MIN_LINK_FACTOR = Math.min(...Object.values(LINK_FACTORS));

function deriveMaxLinkHistory(): number {
  let oddsProduct = 1;
  let linkCount = 0;

  while (oddsProduct * MIN_LINK_FACTOR <= MAX_ODDS_PRODUCT) {
    oddsProduct *= MIN_LINK_FACTOR;
    linkCount += 1;
  }

  return linkCount;
}

function deriveReachableOddsProducts(): Set<number> {
  const reachable = new Set([1]);
  const pending = [1];

  while (pending.length > 0) {
    const oddsProduct = pending.shift()!;
    for (const link of LINKS) {
      const next = oddsProduct * LINK_FACTORS[link];
      if (next <= MAX_ODDS_PRODUCT && !reachable.has(next)) {
        reachable.add(next);
        pending.push(next);
      }
    }
  }

  return reachable;
}

export const MAX_HISTORY_LINKS = deriveMaxLinkHistory();
export const MAX_HISTORY_CARDS = MAX_HISTORY_LINKS + 1;
const LINK_HISTORY_BITS = MAX_HISTORY_LINKS * LINK_BITS;
const MAX_PACKED_LINK_HISTORY = (1 << LINK_HISTORY_BITS) - 1;
const REACHABLE_ODDS_PRODUCTS = deriveReachableOddsProducts();
const GAME_DATA_PARAMS = [{ type: 'uint8' }, { type: 'uint8' }] as const;
const ACTION_DATA_PARAMS = [{ type: 'uint8' }, { type: 'uint8' }] as const;
const GAME_STATE_PARAMS = [
  { type: 'uint8' },
  { type: 'uint8' },
  { type: 'uint16' },
  { type: 'uint8' },
  { type: 'uint64' },
  { type: 'uint16' },
  { type: 'uint8' },
] as const;

const GAME_DATA_BYTES = GAME_DATA_PARAMS.length * ABI_WORD_BYTES;
const ACTION_DATA_BYTES = ACTION_DATA_PARAMS.length * ABI_WORD_BYTES;
const GAME_STATE_BYTES = GAME_STATE_PARAMS.length * ABI_WORD_BYTES;

function assertCard(card: number): void {
  if (!Number.isInteger(card) || card < 0 || card >= CARD_COUNT) {
    throw new RangeError(`Card must be an integer from 0 through ${CARD_COUNT - 1}.`);
  }
}

function assertOddsProduct(oddsProduct: number): void {
  if (!REACHABLE_ODDS_PRODUCTS.has(oddsProduct)) {
    throw new RangeError(`Unreachable odds product: ${oddsProduct}.`);
  }
}

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT8_MAX) {
    throw new RangeError(`${label} must fit in uint${UINT8_BITS}.`);
  }
}

function assertEncodedLength(encoded: Hex, expectedBytes: number, label: string): void {
  if (!/^0x[0-9a-fA-F]*$/.test(encoded) || (encoded.length - 2) / 2 !== expectedBytes) {
    throw new RangeError(`${label} length must be exactly ${expectedBytes} bytes.`);
  }
}

function encodeLink(link: Link): number {
  const code = LINKS.indexOf(link);
  if (code === -1) throw new RangeError(`Unknown link: ${String(link)}`);
  return code;
}

function decodeLink(value: number): Link {
  const link = LINKS[value];
  if (link === undefined) throw new RangeError(`Invalid link code: ${value}.`);
  return link;
}

export function cardSuit(card: number): CardSuit {
  assertCard(card);
  return Math.floor(card / RANK_COUNT) as CardSuit;
}

export function cardRank(card: number): number {
  assertCard(card);
  return card % RANK_COUNT;
}

export function cardColor(card: number): CardColor {
  return SUIT_COLORS[cardSuit(card)];
}

const LINK_MATCHERS: Record<Link, (anchor: number, drawn: number) => boolean> = {
  color: (anchor, drawn) => cardColor(anchor) === cardColor(drawn),
  suit: (anchor, drawn) => cardSuit(anchor) === cardSuit(drawn),
  rank: (anchor, drawn) => cardRank(anchor) === cardRank(drawn),
};

export function isLinkSuccessful(anchor: number, drawn: number, link: Link): boolean {
  const matcher = (
    LINK_MATCHERS as Partial<Record<string, (anchor: number, drawn: number) => boolean>>
  )[link];
  if (matcher === undefined) throw new RangeError(`Unknown link: ${String(link)}`);
  assertCard(anchor);
  assertCard(drawn);
  return matcher(anchor, drawn);
}

export function linkFactor(link: Link): number {
  const factor = (LINK_FACTORS as Partial<Record<string, number>>)[link];
  if (factor === undefined) throw new RangeError(`Unknown link: ${String(link)}`);
  return factor;
}

export function isLinkAvailable(oddsProduct: number, link: Link): boolean {
  assertOddsProduct(oddsProduct);
  return oddsProduct * linkFactor(link) <= MAX_ODDS_PRODUCT;
}

export function availableLinks(oddsProduct: number): Link[] {
  return LINKS.filter(link => isLinkAvailable(oddsProduct, link));
}

export function nextOddsProduct(oddsProduct: number, link: Link): number {
  if (!isLinkAvailable(oddsProduct, link)) {
    throw new RangeError(`${link} is not available at odds product ${oddsProduct}.`);
  }

  return oddsProduct * linkFactor(link);
}

export function cashoutPayout(wager: bigint, oddsProduct: number): bigint {
  if (wager < 0n) throw new RangeError('Wager cannot be negative.');
  assertOddsProduct(oddsProduct);
  if (oddsProduct === 1) throw new RangeError('A route must have a successful link before cash-out.');

  return (wager * RTP_BPS * BigInt(oddsProduct)) / BASIS_POINTS;
}

export function cashoutMultiplier(oddsProduct: number): number {
  assertOddsProduct(oddsProduct);
  return Number(RTP_BPS * BigInt(oddsProduct)) / Number(BASIS_POINTS);
}

export function cardFromRandomness(randomness: Uint8Array): number {
  if (randomness.length !== VRF_WORD_BYTES) {
    throw new RangeError(`Randomness must contain exactly ${VRF_WORD_BYTES} bytes.`);
  }

  let seed: Uint8Array<ArrayBufferLike> = new Uint8Array(randomness);
  let index = 0;

  while (true) {
    if (index === seed.length) {
      seed = hexToBytes(keccak256(seed));
      index = 0;
    }

    const candidate = seed[index];
    index += 1;

    if (candidate < CARD_ACCEPT_LIMIT) return candidate % CARD_COUNT;
  }
}

export function packCardHistory(cards: readonly number[]): bigint {
  if (cards.length > MAX_HISTORY_CARDS) {
    throw new RangeError(`Card history cannot contain more than ${MAX_HISTORY_CARDS} cards.`);
  }

  return cards.reduce((packed, card, index) => {
    assertCard(card);
    return packed | (BigInt(card) << BigInt(index * CARD_BITS));
  }, 0n);
}

export function unpackCardHistory(packed: bigint, cardCount: number): number[] {
  if (packed < 0n) throw new RangeError('Packed card history cannot be negative.');
  if (!Number.isInteger(cardCount) || cardCount < 0 || cardCount > MAX_HISTORY_CARDS) {
    throw new RangeError(`Card count must be an integer from zero through ${MAX_HISTORY_CARDS}.`);
  }

  const cards = Array.from({ length: cardCount }, (_, index) =>
    Number((packed >> BigInt(index * CARD_BITS)) & CARD_MASK),
  );
  cards.forEach(assertCard);

  if ((packed >> BigInt(cardCount * CARD_BITS)) !== 0n) {
    throw new RangeError('Packed card history contains data beyond cardCount.');
  }

  return cards;
}

export function packLinkHistory(links: readonly Link[]): number {
  if (links.length > MAX_HISTORY_LINKS) {
    throw new RangeError(`Link history cannot contain more than ${MAX_HISTORY_LINKS} links.`);
  }

  return links.reduce(
    (packed, link, index) => packed | (encodeLink(link) << (index * LINK_BITS)),
    0,
  );
}

export function unpackLinkHistory(packed: number, linkCount: number): Link[] {
  if (!Number.isInteger(packed) || packed < 0 || packed > MAX_PACKED_LINK_HISTORY) {
    throw new RangeError(`Packed link history must fit in uint${LINK_HISTORY_BITS}.`);
  }
  if (!Number.isInteger(linkCount) || linkCount < 0 || linkCount > MAX_HISTORY_LINKS) {
    throw new RangeError(`Link count must be an integer from zero through ${MAX_HISTORY_LINKS}.`);
  }

  const links = Array.from({ length: linkCount }, (_, index) =>
    decodeLink((packed >> (index * LINK_BITS)) & LINK_MASK),
  );

  if ((packed >> (linkCount * LINK_BITS)) !== 0) {
    throw new RangeError('Packed link history contains data beyond linkCount.');
  }

  return links;
}

export function encodeGameData(gameData: GameData): Hex {
  assertCard(gameData.anchorCard);
  return encodeAbiParameters(GAME_DATA_PARAMS, [gameData.anchorCard, encodeLink(gameData.firstLink)]);
}

export function decodeGameData(encoded: Hex): GameData {
  assertEncodedLength(encoded, GAME_DATA_BYTES, 'Game data');
  const [anchorCard, firstLink] = decodeAbiParameters(GAME_DATA_PARAMS, encoded);
  assertCard(anchorCard);
  return { anchorCard, firstLink: decodeLink(firstLink) };
}

export function encodeActionData(action: PlayerAction): Hex {
  if (action.kind === 'cashout') {
    return encodeAbiParameters(ACTION_DATA_PARAMS, [ACTION_CASHOUT, CASHOUT_LINK_CODE]);
  }
  return encodeAbiParameters(ACTION_DATA_PARAMS, [ACTION_CONTINUE, encodeLink(action.link)]);
}

export function decodeActionData(encoded: Hex): PlayerAction {
  assertEncodedLength(encoded, ACTION_DATA_BYTES, 'Action data');
  const [action, link] = decodeAbiParameters(ACTION_DATA_PARAMS, encoded);
  if (action === ACTION_CASHOUT) {
    if (link !== CASHOUT_LINK_CODE) {
      throw new RangeError('Cash-out action must use the canonical zero link code.');
    }
    return { kind: 'cashout' };
  }
  if (action === ACTION_CONTINUE) return { kind: 'continue', link: decodeLink(link) };
  throw new RangeError(`Invalid action code: ${action}.`);
}

export function encodeGameState(state: GameState): Hex {
  assertCard(state.anchorCard);
  assertOddsProduct(state.oddsProduct);
  assertByte(state.streakLength, 'Streak length');
  assertByte(state.cardCount, 'Card count');
  const cards = unpackCardHistory(state.packedCardHistory, state.cardCount);
  const links = unpackLinkHistory(state.packedLinkHistory, state.cardCount - 1);
  if (cards.length === 0 || cards[cards.length - 1] !== state.anchorCard) {
    throw new RangeError('Anchor card must be the final card in history.');
  }

  const resolvedLinkCount = links.length;
  const isSuccessfulShape = state.streakLength === resolvedLinkCount;
  const isLosingShape = state.streakLength + 1 === resolvedLinkCount;
  if (!isSuccessfulShape && !isLosingShape) {
    throw new RangeError('Streak length is inconsistent with the resolved link history.');
  }
  if (state.pendingLink !== null && !isSuccessfulShape) {
    throw new RangeError('A losing state cannot contain a pending link.');
  }
  if (state.pendingLink === null && resolvedLinkCount === 0) {
    throw new RangeError('A pre-success state must contain a pending link.');
  }

  for (let index = 0; index < state.streakLength; index += 1) {
    if (!isLinkSuccessful(cards[index], cards[index + 1], links[index])) {
      throw new RangeError('Card outcome is inconsistent with the successful link history.');
    }
  }
  if (
    isLosingShape &&
    isLinkSuccessful(cards[cards.length - 2], cards[cards.length - 1], links[links.length - 1])
  ) {
    throw new RangeError('Final card outcome is inconsistent with a losing link history.');
  }

  let expectedOddsProduct = 1;
  for (let index = 0; index < state.streakLength; index += 1) {
    expectedOddsProduct = nextOddsProduct(expectedOddsProduct, links[index]);
  }
  if (expectedOddsProduct !== state.oddsProduct) {
    throw new RangeError('Odds product is inconsistent with the successful link history.');
  }
  if (isLosingShape && !isLinkAvailable(expectedOddsProduct, links[links.length - 1])) {
    throw new RangeError('The final losing link was unavailable at the recorded odds product.');
  }
  if (state.pendingLink !== null && !isLinkAvailable(state.oddsProduct, state.pendingLink)) {
    throw new RangeError('Pending link is unavailable at the recorded odds product.');
  }

  return encodeAbiParameters(GAME_STATE_PARAMS, [
    state.anchorCard,
    state.pendingLink === null ? LINK_NONE : encodeLink(state.pendingLink),
    state.oddsProduct,
    state.streakLength,
    state.packedCardHistory,
    state.packedLinkHistory,
    state.cardCount,
  ]);
}

export function decodeGameState(encoded: Hex): GameState {
  assertEncodedLength(encoded, GAME_STATE_BYTES, 'Game state');
  const [
    anchorCard,
    pendingLinkCode,
    oddsProduct,
    streakLength,
    packedCardHistory,
    packedLinkHistory,
    cardCount,
  ] = decodeAbiParameters(GAME_STATE_PARAMS, encoded);
  const pendingLink = pendingLinkCode === LINK_NONE ? null : decodeLink(pendingLinkCode);
  const state = {
    anchorCard,
    pendingLink,
    oddsProduct,
    streakLength,
    packedCardHistory,
    packedLinkHistory,
    cardCount,
  } satisfies GameState;

  encodeGameState(state);
  return state;
}
