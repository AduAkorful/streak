// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ICasinoGameV2, SessionContext, SessionPhase, StepResult} from '../../casino-sdk/solidity/ICasinoGameV2.sol';

/// @title StreakGame
/// @notice Card-link prediction game for the Chain Casino SDK.
contract StreakGame is ICasinoGameV2 {
  uint16 public constant RTP_BPS = 9_600;
  uint16 public constant BASIS_POINTS = 10_000;
  uint16 public constant MAX_ODDS_PRODUCT = 256;
  uint8 public constant SUIT_COUNT = 4;
  uint8 public constant RANK_COUNT = 13;
  uint8 public constant CARD_COUNT = SUIT_COUNT * RANK_COUNT;
  uint8 public constant CARD_ACCEPT_LIMIT = 208;
  uint8 public constant MAX_CARD_HISTORY = 9;
  uint8 public constant MAX_LINK_HISTORY = 8;
  uint256 public constant TOP_PAYOUT_PROBABILITY_WAD = 1e18 / MAX_ODDS_PRODUCT;

  uint8 private constant ACTION_CASHOUT = 0;
  uint8 private constant ACTION_CONTINUE = 1;
  uint8 private constant LINK_NONE = 3;
  uint8 private constant CARD_BITS = 6;
  uint8 private constant LINK_BITS = 2;
  uint64 private constant CARD_MASK = (uint64(1) << CARD_BITS) - 1;
  uint16 private constant LINK_MASK = (uint16(1) << LINK_BITS) - 1;
  uint256 private constant GAME_DATA_BYTES = 64;
  uint256 private constant ACTION_DATA_BYTES = 64;
  uint256 private constant GAME_STATE_BYTES = 224;

  struct StreakState {
    uint8 anchorCard;
    uint8 pendingLink;
    uint16 oddsProduct;
    uint8 streakLength;
    uint64 packedCardHistory;
    uint16 packedLinkHistory;
    uint8 cardCount;
  }

  error InvalidWager();
  error InvalidGameDataLength(uint256 actual);
  error InvalidActionDataLength(uint256 actual);
  error InvalidGameStateLength(uint256 actual);
  error InvalidCard(uint256 card);
  error InvalidLink(uint256 link);
  error InvalidAction(uint256 action);
  error InvalidOddsProduct(uint256 oddsProduct);
  error LinkUnavailable(uint256 oddsProduct, uint256 link);
  error InvalidCardHistory();
  error InvalidLinkHistory();
  error InvalidStateShape();
  error ExistingGameState();
  error MathOverflowedMulDiv();

  function quoteCaps(
    uint256 wager,
    bytes calldata gameData
  ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
    if (wager == 0) revert InvalidWager();
    _decodeGameData(gameData);
    uint256 maxPayout = _cashout(wager, MAX_ODDS_PRODUCT);
    return (wager, maxPayout - wager);
  }

  function quoteRiskParams(
    uint256 wager,
    bytes calldata gameData
  )
    external
    pure
    returns (
      uint256 maxPayout,
      uint256 probabilityWad,
      uint256 expectedPayout,
      uint256 subJackpotVarianceScaled
    )
  {
    if (wager == 0) revert InvalidWager();
    _decodeGameData(gameData);
    maxPayout = _cashout(wager, MAX_ODDS_PRODUCT);
    probabilityWad = TOP_PAYOUT_PROBABILITY_WAD;
    expectedPayout = _mulDiv(wager, RTP_BPS, BASIS_POINTS);
    subJackpotVarianceScaled = 0;
  }

  function onSessionStart(
    SessionContext calldata ctx
  ) external pure returns (StepResult memory result) {
    if (ctx.wagerBase == 0) revert InvalidWager();
    if (ctx.gameState.length != 0) revert ExistingGameState();
    (uint8 anchorCard, uint8 firstLink) = _decodeGameData(ctx.gameData);
    StreakState memory state = StreakState({
      anchorCard: anchorCard,
      pendingLink: firstLink,
      oddsProduct: 1,
      streakLength: 0,
      packedCardHistory: uint64(anchorCard),
      packedLinkHistory: 0,
      cardCount: 1
    });
    result.newGameState = _encodeState(state);
    result.escrowDelta = 0;
    result.reservedProfitDelta = int256(_cashout(ctx.wagerBase, MAX_ODDS_PRODUCT) - ctx.wagerBase);
    result.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    result.requestRandomnessNow = true;
    result.payout = 0;
  }

  function onPlayerAction(
    SessionContext calldata ctx,
    bytes calldata actionData
  ) external pure returns (StepResult memory result) {
    StreakState memory state = _decodeAndValidateState(ctx.gameState);
    if (
      state.pendingLink != LINK_NONE ||
      state.streakLength != state.cardCount - 1 ||
      state.streakLength == 0 ||
      !_hasAvailableLink(state.oddsProduct)
    ) {
      revert InvalidStateShape();
    }

    (uint8 action, uint8 nextLink) = _decodeActionData(actionData);
    if (action == ACTION_CASHOUT) {
      result.newGameState = ctx.gameState;
      result.nextPhase = SessionPhase.SETTLED;
      result.payout = _cashout(ctx.wagerBase, state.oddsProduct);
      return result;
    }
    if (action != ACTION_CONTINUE) revert InvalidAction(action);
    if (!_isAvailable(state.oddsProduct, nextLink)) {
      revert LinkUnavailable(state.oddsProduct, nextLink);
    }

    state.pendingLink = nextLink;
    result.newGameState = _encodeState(state);
    result.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    result.requestRandomnessNow = true;
  }

  function onRandomness(
    SessionContext calldata ctx,
    bytes32 randomness
  ) external pure returns (StepResult memory result) {
    StreakState memory state = _decodeAndValidateState(ctx.gameState);
    if (state.pendingLink == LINK_NONE || state.streakLength != state.cardCount - 1) {
      revert InvalidStateShape();
    }

    uint8 previousAnchor = state.anchorCard;
    uint8 selectedLink = state.pendingLink;
    uint8 drawnCard = _cardFromRandomness(randomness);
    if (state.cardCount >= MAX_CARD_HISTORY) revert InvalidStateShape();

    state.packedCardHistory |= uint64(drawnCard) << (state.cardCount * CARD_BITS);
    state.packedLinkHistory |= uint16(selectedLink) << ((state.cardCount - 1) * LINK_BITS);
    state.anchorCard = drawnCard;
    state.pendingLink = LINK_NONE;
    state.cardCount += 1;

    if (!_isSuccessful(previousAnchor, drawnCard, selectedLink)) {
      result.newGameState = _encodeState(state);
      result.nextPhase = SessionPhase.SETTLED;
      return result;
    }

    state.oddsProduct = uint16(state.oddsProduct * _linkFactor(selectedLink));
    state.streakLength += 1;
    result.newGameState = _encodeState(state);
    if (_hasAvailableLink(state.oddsProduct)) {
      result.nextPhase = SessionPhase.WAITING_PLAYER_ACTION;
    } else {
      result.nextPhase = SessionPhase.SETTLED;
      result.payout = _cashout(ctx.wagerBase, state.oddsProduct);
    }
  }

  function quoteForfeitPayout(SessionContext calldata ctx) external view returns (uint256 cashoutValue) {
    if (ctx.gameState.length != GAME_STATE_BYTES) return 0;
    try this.validateGameState(ctx.gameState) returns (StreakState memory state) {
      if (
        state.pendingLink == LINK_NONE &&
        state.streakLength == state.cardCount - 1 &&
        state.streakLength > 0 &&
        _hasAvailableLink(state.oddsProduct)
      ) {
        return _cashout(ctx.wagerBase, state.oddsProduct);
      }
    } catch {}
    return 0;
  }

  function validateGameState(bytes calldata encoded) external pure returns (StreakState memory) {
    return _decodeAndValidateState(encoded);
  }

  function _decodeGameData(bytes calldata encoded) private pure returns (uint8 anchorCard, uint8 firstLink) {
    if (encoded.length != GAME_DATA_BYTES) revert InvalidGameDataLength(encoded.length);
    (anchorCard, firstLink) = abi.decode(encoded, (uint8, uint8));
    _assertCard(anchorCard);
    _assertLink(firstLink);
  }

  function _decodeActionData(bytes calldata encoded) private pure returns (uint8 action, uint8 nextLink) {
    if (encoded.length != ACTION_DATA_BYTES) revert InvalidActionDataLength(encoded.length);
    (action, nextLink) = abi.decode(encoded, (uint8, uint8));
    if (action == ACTION_CASHOUT) {
      if (nextLink != 0) revert InvalidLink(nextLink);
      return (action, nextLink);
    }
    if (action == ACTION_CONTINUE) {
      _assertLink(nextLink);
      return (action, nextLink);
    }
    revert InvalidAction(action);
  }

  function _decodeAndValidateState(bytes calldata encoded) private pure returns (StreakState memory state) {
    if (encoded.length != GAME_STATE_BYTES) revert InvalidGameStateLength(encoded.length);
    state = abi.decode(encoded, (StreakState));
    _validateState(state);
  }

  function _validateState(StreakState memory state) private pure {
    _assertCard(state.anchorCard);
    if (state.cardCount == 0 || state.cardCount > MAX_CARD_HISTORY) revert InvalidStateShape();
    if (state.streakLength > MAX_LINK_HISTORY) revert InvalidStateShape();
    if (state.pendingLink != LINK_NONE && state.pendingLink > 2) revert InvalidLink(state.pendingLink);
    _assertOddsProduct(state.oddsProduct);

    uint8 resolvedLinks = state.cardCount - 1;
    if ((state.packedCardHistory >> (state.cardCount * CARD_BITS)) != 0) revert InvalidCardHistory();
    if ((state.packedLinkHistory >> (resolvedLinks * LINK_BITS)) != 0) revert InvalidLinkHistory();
    if (state.streakLength == resolvedLinks) {
      if (state.cardCount == 1 && state.pendingLink == LINK_NONE) revert InvalidStateShape();
      if (state.pendingLink != LINK_NONE && !_isAvailable(state.oddsProduct, state.pendingLink)) {
        revert LinkUnavailable(state.oddsProduct, state.pendingLink);
      }
    } else if (state.streakLength + 1 == resolvedLinks) {
      if (state.pendingLink != LINK_NONE || state.cardCount < 2) revert InvalidStateShape();
    } else {
      revert InvalidStateShape();
    }

    uint8 previousCard = _cardAt(state.packedCardHistory, 0);
    for (uint8 index = 0; index < resolvedLinks; index++) {
      uint8 card = _cardAt(state.packedCardHistory, index + 1);
      uint8 link = _linkAt(state.packedLinkHistory, index);
      if (index < state.streakLength) {
        if (!_isSuccessful(previousCard, card, link)) revert InvalidStateShape();
      } else if (_isSuccessful(previousCard, card, link) || !_isAvailable(state.oddsProduct, link)) {
        revert InvalidStateShape();
      }
      previousCard = card;
    }
    if (previousCard != state.anchorCard) revert InvalidCardHistory();

    uint16 expectedOdds = 1;
    for (uint8 index = 0; index < state.streakLength; index++) {
      expectedOdds = uint16(expectedOdds * _linkFactor(_linkAt(state.packedLinkHistory, index)));
    }
    if (expectedOdds != state.oddsProduct) revert InvalidStateShape();
  }

  function _encodeState(StreakState memory state) private pure returns (bytes memory) {
    return abi.encode(
      state.anchorCard,
      state.pendingLink,
      state.oddsProduct,
      state.streakLength,
      state.packedCardHistory,
      state.packedLinkHistory,
      state.cardCount
    );
  }

  function _cardFromRandomness(bytes32 randomness) private pure returns (uint8 card) {
    bytes32 seed = randomness;
    uint8 index;
    while (true) {
      uint8 candidate = uint8(uint256(seed >> (248 - (index * 8))));
      index += 1;
      if (candidate < CARD_ACCEPT_LIMIT) return candidate % CARD_COUNT;
      if (index == 32) {
        seed = keccak256(abi.encodePacked(seed));
        index = 0;
      }
    }
  }

  function _isSuccessful(uint8 anchor, uint8 drawn, uint8 link) private pure returns (bool) {
    _assertCard(anchor);
    _assertCard(drawn);
    _assertLink(link);
    if (link == 0) return _color(anchor) == _color(drawn);
    if (link == 1) return anchor / RANK_COUNT == drawn / RANK_COUNT;
    return anchor % RANK_COUNT == drawn % RANK_COUNT;
  }

  function _hasAvailableLink(uint16 oddsProduct) private pure returns (bool) {
    return _isAvailable(oddsProduct, 0) || _isAvailable(oddsProduct, 1) || _isAvailable(oddsProduct, 2);
  }

  function _isAvailable(uint16 oddsProduct, uint8 link) private pure returns (bool) {
    _assertOddsProduct(oddsProduct);
    _assertLink(link);
    return uint256(oddsProduct) * _linkFactor(link) <= MAX_ODDS_PRODUCT;
  }

  function _linkFactor(uint8 link) private pure returns (uint8) {
    _assertLink(link);
    if (link == 0) return 2;
    if (link == 1) return 4;
    return 13;
  }

  function _cashout(uint256 wager, uint16 oddsProduct) private pure returns (uint256) {
    _assertOddsProduct(oddsProduct);
    if (oddsProduct == 1) return 0;
    return _mulDiv(wager, uint256(RTP_BPS) * oddsProduct, BASIS_POINTS);
  }

  function _mulDiv(uint256 x, uint256 y, uint256 denominator) private pure returns (uint256 result) {
    uint256 prod0;
    uint256 prod1;
    assembly ('memory-safe') {
      let mm := mulmod(x, y, not(0))
      prod0 := mul(x, y)
      prod1 := sub(sub(mm, prod0), lt(mm, prod0))
    }
    if (prod1 == 0) return prod0 / denominator;
    if (denominator <= prod1) revert MathOverflowedMulDiv();

    uint256 remainder;
    assembly ('memory-safe') {
      remainder := mulmod(x, y, denominator)
      prod1 := sub(prod1, gt(remainder, prod0))
      prod0 := sub(prod0, remainder)
    }

    uint256 twos = denominator & (0 - denominator);
    assembly ('memory-safe') {
      denominator := div(denominator, twos)
      prod0 := div(prod0, twos)
      twos := add(div(sub(0, twos), twos), 1)
    }
    prod0 |= prod1 * twos;

    uint256 inverse = (3 * denominator) ^ 2;
    inverse *= 2 - denominator * inverse;
    inverse *= 2 - denominator * inverse;
    inverse *= 2 - denominator * inverse;
    inverse *= 2 - denominator * inverse;
    inverse *= 2 - denominator * inverse;
    inverse *= 2 - denominator * inverse;
    result = prod0 * inverse;
  }

  function _assertCard(uint8 card) private pure {
    if (card >= CARD_COUNT) revert InvalidCard(card);
  }

  function _assertLink(uint8 link) private pure {
    if (link > 2) revert InvalidLink(link);
  }

  function _assertOddsProduct(uint16 oddsProduct) private pure {
    if (!_isReachable(oddsProduct)) revert InvalidOddsProduct(oddsProduct);
  }

  function _isReachable(uint16 oddsProduct) private pure returns (bool) {
    if (oddsProduct == 0 || oddsProduct > MAX_ODDS_PRODUCT) return false;
    uint16 remaining = oddsProduct;
    while (remaining % 2 == 0) remaining /= 2;
    while (remaining % 13 == 0) remaining /= 13;
    return remaining == 1;
  }

  function _cardAt(uint64 packed, uint8 index) private pure returns (uint8) {
    uint8 card = uint8((packed >> (index * CARD_BITS)) & CARD_MASK);
    _assertCard(card);
    return card;
  }

  function _linkAt(uint16 packed, uint8 index) private pure returns (uint8) {
    uint8 link = uint8((packed >> (index * LINK_BITS)) & LINK_MASK);
    _assertLink(link);
    return link;
  }

  function _color(uint8 card) private pure returns (uint8) {
    uint8 suit = card / RANK_COUNT;
    return (suit == 1 || suit == 2) ? 1 : 0;
  }
}
