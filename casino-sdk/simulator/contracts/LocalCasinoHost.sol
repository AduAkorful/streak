// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ICasinoGameV2, SessionContext, SessionPhase, StepResult } from '../../solidity/ICasinoGameV2.sol';

interface IVerifyNetworkRouter {
  function requestRandomness() external returns (bytes32 requestId);
}

interface IERC20Minimal {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function approve(address spender, uint256 amount) external returns (bool);
  function decimals() external view returns (uint8);
}

/// @notice Trivial liquidity pool standing in for the production ERC4626 vault:
///         it holds the house funds and lets the host move them for payouts.
contract LocalCasinoVault {
  address public immutable asset;

  constructor(address token, address host) {
    asset = token;
    IERC20Minimal(token).approve(host, type(uint256).max);
  }
}

/**
 * @notice Minimal stand-in for the production CasinoGameFacet, for testing
 *         ICasinoGameV2 games locally. It reproduces the facet's session
 *         lifecycle and emits byte-identical events (off-chain decoders rely
 *         on the exact shape), but drops everything a local harness doesn't
 *         need: the diamond, access control, portfolio risk accounting,
 *         min/max bet policies, and the randomness provider indirection (this
 *         host is its own Verify Network router client — fund it via
 *         router.depositClientBalance(host)).
 */
contract LocalCasinoHost {
  struct Session {
    address player;
    address game;
    uint256 wagerBase;
    uint256 escrowedStake;
    uint256 reservedProfit;
    uint256 maxEscrowStake;
    uint256 maxReservedProfit;
    uint256 actionDeadlineBlock;
    uint256 randomnessDeadlineBlock;
    uint32 step;
    uint64 pendingRequestNonce;
    bytes32 pendingRequestId;
    SessionPhase phase;
    bytes gameData;
    bytes gameState;
    bytes randomnessRequestData;
  }

  // Same defaults as the production facet.
  uint256 public constant ACTION_TIMEOUT_BLOCKS = 43200;
  uint256 public constant RANDOMNESS_TIMEOUT_BLOCKS = 15;
  uint256 private constant WAD = 1e18;
  uint16 private constant BASIS_POINTS = 10_000;
  uint16 private constant FORFEIT_WINNINGS_CUT_BPS = 1_000;
  uint256 private constant FORFEIT_QUOTE_GAS_LIMIT = 400_000;

  IVerifyNetworkRouter public immutable router;
  address public immutable token;
  address public immutable vault;
  uint256 public currentSessionId;

  mapping(uint256 => Session) private sessions;
  mapping(bytes32 => uint256) private requestToSession;
  mapping(bytes32 => uint64) private requestToNonce;
  mapping(address => string) public gameNames;

  // Events identical to the production CasinoGameFacet — decoders rely on the exact shape.
  event GameWhitelistUpdated(address indexed game, bool whitelisted, string gameName);
  event CasinoSessionOpened(
    uint256 indexed sessionId,
    address indexed game,
    address indexed player,
    address vault,
    address token,
    uint8 tokenDecimals,
    uint256 wager,
    uint256 maxEscrowStake,
    uint256 maxReservedProfit,
    string gameName,
    bytes gameData
  );
  event CasinoSessionPhaseAdvanced(
    uint256 indexed sessionId,
    uint32 indexed step,
    SessionPhase phase,
    uint256 actionDeadlineBlock,
    uint256 randomnessDeadlineBlock,
    bytes gameState
  );
  event CasinoSessionRandomnessRequested(
    uint256 indexed sessionId,
    address indexed provider,
    bytes32 indexed requestId,
    uint64 requestNonce,
    uint256 randomnessDeadlineBlock
  );
  event CasinoSessionRandomnessFulfilled(
    uint256 indexed sessionId,
    address indexed provider,
    bytes32 indexed requestId,
    uint64 requestNonce,
    bytes32 randomness
  );
  event CasinoSessionSettled(
    uint256 indexed sessionId,
    address indexed game,
    address indexed player,
    SessionPhase phase,
    uint256 payout,
    string gameName,
    bytes gameState
  );
  event CasinoSessionEscrowUpdated(
    uint256 indexed sessionId,
    uint32 indexed step,
    uint256 previousEscrowedStake,
    uint256 escrowedStake
  );

  error LocalCasinoHost__InvalidWager();
  error LocalCasinoHost__UnsupportedVault(address vault);
  error LocalCasinoHost__GameNotRegistered(address game);
  error LocalCasinoHost__InvalidSessionCaps(uint256 wager, uint256 maxEscrowStake);
  error LocalCasinoHost__InvalidRiskProbability();
  error LocalCasinoHost__SessionNotFound(uint256 sessionId);
  error LocalCasinoHost__InvalidSessionPhase(uint256 sessionId, SessionPhase expected, SessionPhase actual);
  error LocalCasinoHost__NotSessionPlayer(uint256 sessionId, address caller);
  error LocalCasinoHost__ActionDeadlinePassed(uint256 sessionId, uint256 deadlineBlock);
  error LocalCasinoHost__ActionDeadlineNotPassed(uint256 sessionId, uint256 deadlineBlock);
  error LocalCasinoHost__RandomnessDeadlineNotPassed(uint256 sessionId, uint256 deadlineBlock);
  error LocalCasinoHost__OnlyRouter(address caller);
  error LocalCasinoHost__UnknownRandomnessRequest(bytes32 requestId);
  error LocalCasinoHost__StaleRandomnessCallback(uint256 sessionId, uint64 expectedNonce, uint64 actualNonce);
  error LocalCasinoHost__EscrowIncreaseNotAllowed();
  error LocalCasinoHost__EscrowUnderflow(uint256 currentEscrow, uint256 decreaseAmount);
  error LocalCasinoHost__ReservedProfitUnderflow(uint256 currentReservedProfit, uint256 decreaseAmount);
  error LocalCasinoHost__EscrowCapExceeded(uint256 escrowedStake, uint256 maxEscrowStake);
  error LocalCasinoHost__ReservedProfitCapExceeded(uint256 reservedProfit, uint256 maxReservedProfit);
  error LocalCasinoHost__InvalidStepTransition(SessionPhase nextPhase, bool requestRandomnessNow);
  error LocalCasinoHost__InvalidPayout(uint256 maxAllowedPayout, uint256 payout);
  error LocalCasinoHost__InvalidProviderRandomness();

  constructor(address token_, address router_) {
    token = token_;
    router = IVerifyNetworkRouter(router_);
    vault = address(new LocalCasinoVault(token_, address(this)));
  }

  /// @notice Local-only, permissionless stand-in for the security-council whitelist.
  function registerGame(address game, string calldata gameName) external {
    gameNames[game] = gameName;
    emit GameWhitelistUpdated(game, true, gameName);
  }

  function getGameName(address game) external view returns (string memory gameName) {
    return gameNames[game];
  }

  function getSession(uint256 sessionId) external view returns (Session memory session) {
    return sessions[sessionId];
  }

  function openSession(
    address game,
    address vault_,
    uint256 wager,
    bytes calldata gameData,
    bytes calldata randomnessRequestData
  ) external returns (uint256 sessionId, bytes32 requestId) {
    if (wager == 0) revert LocalCasinoHost__InvalidWager();
    if (vault_ != vault) revert LocalCasinoHost__UnsupportedVault(vault_);
    if (bytes(gameNames[game]).length == 0) revert LocalCasinoHost__GameNotRegistered(game);

    (uint256 maxEscrowStake, uint256 maxReservedProfit) = ICasinoGameV2(game).quoteCaps(wager, gameData);
    if (maxEscrowStake < wager) revert LocalCasinoHost__InvalidSessionCaps(wager, maxEscrowStake);
    // Keep games honest about the production risk interface even though the
    // harness runs no portfolio accounting.
    (, uint256 probabilityWad, , ) = ICasinoGameV2(game).quoteRiskParams(wager, gameData);
    if (probabilityWad > WAD) revert LocalCasinoHost__InvalidRiskProbability();

    IERC20Minimal(token).transferFrom(msg.sender, address(this), wager);

    sessionId = ++currentSessionId;
    Session storage session = sessions[sessionId];
    session.player = msg.sender;
    session.game = game;
    session.wagerBase = wager;
    session.escrowedStake = wager;
    session.maxEscrowStake = maxEscrowStake;
    session.maxReservedProfit = maxReservedProfit;
    session.phase = SessionPhase.NONE;
    session.gameData = gameData;
    session.randomnessRequestData = randomnessRequestData;

    emit CasinoSessionOpened(
      sessionId,
      game,
      msg.sender,
      vault,
      token,
      IERC20Minimal(token).decimals(),
      wager,
      maxEscrowStake,
      maxReservedProfit,
      gameNames[game],
      gameData
    );

    StepResult memory stepResult = ICasinoGameV2(game).onSessionStart(_toSessionContext(sessionId, session));
    requestId = _processStepResult(sessionId, session, stepResult, true);
  }

  function submitAction(
    uint256 sessionId,
    bytes calldata actionData,
    bytes calldata randomnessRequestData
  ) external returns (bytes32 requestId) {
    Session storage session = sessions[sessionId];
    _requireSessionExists(sessionId, session);
    _requirePhase(sessionId, session.phase, SessionPhase.WAITING_PLAYER_ACTION);
    if (session.player != msg.sender) revert LocalCasinoHost__NotSessionPlayer(sessionId, msg.sender);
    if (block.number > session.actionDeadlineBlock) {
      revert LocalCasinoHost__ActionDeadlinePassed(sessionId, session.actionDeadlineBlock);
    }

    session.randomnessRequestData = randomnessRequestData;
    StepResult memory stepResult = ICasinoGameV2(session.game).onPlayerAction(
      _toSessionContext(sessionId, session),
      actionData
    );
    requestId = _processStepResult(sessionId, session, stepResult, true);
  }

  /// @notice Verify Network router VRF callback (IVerifyNetworkVrfReceiver).
  function onRandomnessFulfilled(bytes32 requestId, bytes32 randomness) external {
    if (msg.sender != address(router)) revert LocalCasinoHost__OnlyRouter(msg.sender);
    if (randomness == bytes32(0)) revert LocalCasinoHost__InvalidProviderRandomness();

    uint256 sessionId = requestToSession[requestId];
    if (sessionId == 0) revert LocalCasinoHost__UnknownRandomnessRequest(requestId);
    Session storage session = sessions[sessionId];
    _requirePhase(sessionId, session.phase, SessionPhase.WAITING_RANDOMNESS);
    uint64 requestNonce = requestToNonce[requestId];
    if (session.pendingRequestNonce != requestNonce) {
      revert LocalCasinoHost__StaleRandomnessCallback(sessionId, session.pendingRequestNonce, requestNonce);
    }

    delete requestToSession[requestId];
    delete requestToNonce[requestId];
    session.pendingRequestId = bytes32(0);
    session.randomnessDeadlineBlock = 0;

    emit CasinoSessionRandomnessFulfilled(sessionId, msg.sender, requestId, requestNonce, randomness);

    StepResult memory stepResult = ICasinoGameV2(session.game).onRandomness(
      _toSessionContext(sessionId, session),
      randomness
    );
    _processStepResult(sessionId, session, stepResult, false);
  }

  function cancelStuckRandomness(uint256 sessionId) external returns (uint256 payout) {
    Session storage session = sessions[sessionId];
    _requireSessionExists(sessionId, session);
    _requirePhase(sessionId, session.phase, SessionPhase.WAITING_RANDOMNESS);
    if (block.number <= session.randomnessDeadlineBlock) {
      revert LocalCasinoHost__RandomnessDeadlineNotPassed(sessionId, session.randomnessDeadlineBlock);
    }

    if (session.pendingRequestId != bytes32(0)) {
      delete requestToSession[session.pendingRequestId];
      delete requestToNonce[session.pendingRequestId];
      session.pendingRequestId = bytes32(0);
      session.randomnessDeadlineBlock = 0;
    }

    payout = session.escrowedStake;
    _finalizeSession(sessionId, session, SessionPhase.CANCELLED, payout);
  }

  function forfeitExpiredSession(uint256 sessionId) external returns (uint256 payout) {
    Session storage session = sessions[sessionId];
    _requireSessionExists(sessionId, session);
    _requirePhase(sessionId, session.phase, SessionPhase.WAITING_PLAYER_ACTION);
    if (block.number <= session.actionDeadlineBlock) {
      revert LocalCasinoHost__ActionDeadlineNotPassed(sessionId, session.actionDeadlineBlock);
    }
    payout = _quoteForfeitPayout(sessionId, session);
    _finalizeSession(sessionId, session, SessionPhase.FORFEITED, payout);
  }

  /// @dev Same forfeit payout rule as the production facet: the player keeps their
  ///      current cash-out value minus FORFEIT_WINNINGS_CUT_BPS, and any quote
  ///      failure (game predates quoteForfeitPayout, revert, bad return) pays 0.
  function _quoteForfeitPayout(
    uint256 sessionId,
    Session storage session
  ) private view returns (uint256 payout) {
    address game = session.game;
    bytes memory quoteCalldata = abi.encodeCall(
      ICasinoGameV2.quoteForfeitPayout,
      (_toSessionContext(sessionId, session))
    );

    uint256 quote;
    bool success;
    assembly ('memory-safe') {
      let output := mload(0x40)
      success := staticcall(
        FORFEIT_QUOTE_GAS_LIMIT,
        game,
        add(quoteCalldata, 0x20),
        mload(quoteCalldata),
        output,
        0x20
      )
      if iszero(eq(returndatasize(), 0x20)) {
        success := 0
      }
      quote := mload(output)
    }
    if (!success) {
      return 0;
    }

    uint256 maxAllowedPayout = session.escrowedStake + session.reservedProfit;
    if (quote > maxAllowedPayout) {
      quote = maxAllowedPayout;
    }
    payout = (quote * (BASIS_POINTS - FORFEIT_WINNINGS_CUT_BPS)) / BASIS_POINTS;
  }

  function _processStepResult(
    uint256 sessionId,
    Session storage session,
    StepResult memory stepResult,
    bool allowEscrowIncrease
  ) private returns (bytes32 requestId) {
    uint256 previousEscrowedStake = session.escrowedStake;
    _applyStepDeltas(session, stepResult, allowEscrowIncrease);

    if (session.escrowedStake > session.maxEscrowStake) {
      revert LocalCasinoHost__EscrowCapExceeded(session.escrowedStake, session.maxEscrowStake);
    }
    if (session.reservedProfit > session.maxReservedProfit) {
      revert LocalCasinoHost__ReservedProfitCapExceeded(session.reservedProfit, session.maxReservedProfit);
    }

    session.gameState = stepResult.newGameState;
    session.step += 1;

    if (session.escrowedStake != previousEscrowedStake) {
      emit CasinoSessionEscrowUpdated(
        sessionId,
        session.step,
        previousEscrowedStake,
        session.escrowedStake
      );
    }

    if (stepResult.nextPhase == SessionPhase.WAITING_RANDOMNESS) {
      if (!stepResult.requestRandomnessNow) {
        revert LocalCasinoHost__InvalidStepTransition(stepResult.nextPhase, stepResult.requestRandomnessNow);
      }
      session.phase = SessionPhase.WAITING_RANDOMNESS;
      session.actionDeadlineBlock = 0;
      requestId = _requestRandomness(sessionId, session);
    } else if (stepResult.nextPhase == SessionPhase.WAITING_PLAYER_ACTION) {
      if (stepResult.requestRandomnessNow) {
        revert LocalCasinoHost__InvalidStepTransition(stepResult.nextPhase, stepResult.requestRandomnessNow);
      }
      session.phase = SessionPhase.WAITING_PLAYER_ACTION;
      session.pendingRequestId = bytes32(0);
      session.actionDeadlineBlock = block.number + ACTION_TIMEOUT_BLOCKS;
      session.randomnessDeadlineBlock = 0;
      emit CasinoSessionPhaseAdvanced(
        sessionId,
        session.step,
        session.phase,
        session.actionDeadlineBlock,
        session.randomnessDeadlineBlock,
        session.gameState
      );
    } else if (_isTerminalPhase(stepResult.nextPhase)) {
      if (stepResult.requestRandomnessNow) {
        revert LocalCasinoHost__InvalidStepTransition(stepResult.nextPhase, stepResult.requestRandomnessNow);
      }
      _finalizeSession(sessionId, session, stepResult.nextPhase, stepResult.payout);
    } else {
      revert LocalCasinoHost__InvalidStepTransition(stepResult.nextPhase, stepResult.requestRandomnessNow);
    }
  }

  function _applyStepDeltas(
    Session storage session,
    StepResult memory stepResult,
    bool allowEscrowIncrease
  ) private {
    if (stepResult.escrowDelta > 0) {
      if (!allowEscrowIncrease) revert LocalCasinoHost__EscrowIncreaseNotAllowed();
      uint256 increaseEscrow = uint256(stepResult.escrowDelta);
      IERC20Minimal(token).transferFrom(session.player, address(this), increaseEscrow);
      session.escrowedStake += increaseEscrow;
    } else if (stepResult.escrowDelta < 0) {
      uint256 decreaseEscrow = uint256(-stepResult.escrowDelta);
      if (decreaseEscrow > session.escrowedStake) {
        revert LocalCasinoHost__EscrowUnderflow(session.escrowedStake, decreaseEscrow);
      }
      session.escrowedStake -= decreaseEscrow;
      IERC20Minimal(token).transfer(session.player, decreaseEscrow);
    }

    if (stepResult.reservedProfitDelta > 0) {
      session.reservedProfit += uint256(stepResult.reservedProfitDelta);
    } else if (stepResult.reservedProfitDelta < 0) {
      uint256 decreaseReservedProfit = uint256(-stepResult.reservedProfitDelta);
      if (decreaseReservedProfit > session.reservedProfit) {
        revert LocalCasinoHost__ReservedProfitUnderflow(session.reservedProfit, decreaseReservedProfit);
      }
      session.reservedProfit -= decreaseReservedProfit;
    }
  }

  function _requestRandomness(uint256 sessionId, Session storage session) private returns (bytes32 requestId) {
    uint64 requestNonce = session.pendingRequestNonce + 1;
    session.pendingRequestNonce = requestNonce;

    requestId = router.requestRandomness();

    session.pendingRequestId = requestId;
    session.randomnessDeadlineBlock = block.number + RANDOMNESS_TIMEOUT_BLOCKS;
    requestToSession[requestId] = sessionId;
    requestToNonce[requestId] = requestNonce;

    emit CasinoSessionRandomnessRequested(
      sessionId,
      address(router),
      requestId,
      requestNonce,
      session.randomnessDeadlineBlock
    );
    emit CasinoSessionPhaseAdvanced(
      sessionId,
      session.step,
      session.phase,
      session.actionDeadlineBlock,
      session.randomnessDeadlineBlock,
      session.gameState
    );
  }

  function _finalizeSession(
    uint256 sessionId,
    Session storage session,
    SessionPhase terminalPhase,
    uint256 payout
  ) private {
    uint256 maxAllowedPayout = session.escrowedStake + session.reservedProfit;
    if (payout > maxAllowedPayout) revert LocalCasinoHost__InvalidPayout(maxAllowedPayout, payout);

    uint256 escrowedStake = session.escrowedStake;
    uint256 payoutFromEscrow = payout > escrowedStake ? escrowedStake : payout;
    uint256 payoutFromVault = payout > escrowedStake ? payout - escrowedStake : 0;
    uint256 escrowToVault = escrowedStake - payoutFromEscrow;
    address player = session.player;

    session.reservedProfit = 0;
    session.escrowedStake = 0;
    session.phase = terminalPhase;
    session.actionDeadlineBlock = 0;
    session.randomnessDeadlineBlock = 0;
    session.pendingRequestId = bytes32(0);

    emit CasinoSessionPhaseAdvanced(sessionId, session.step, terminalPhase, 0, 0, session.gameState);
    emit CasinoSessionSettled(
      sessionId,
      session.game,
      player,
      terminalPhase,
      payout,
      gameNames[session.game],
      session.gameState
    );

    if (payoutFromEscrow > 0) IERC20Minimal(token).transfer(player, payoutFromEscrow);
    if (payoutFromVault > 0) IERC20Minimal(token).transferFrom(vault, player, payoutFromVault);
    if (escrowToVault > 0) IERC20Minimal(token).transfer(vault, escrowToVault);
  }

  function _toSessionContext(
    uint256 sessionId,
    Session storage session
  ) private view returns (SessionContext memory ctx) {
    ctx = SessionContext({
      sessionId: sessionId,
      player: session.player,
      vault: vault,
      wagerBase: session.wagerBase,
      escrowedStake: session.escrowedStake,
      reservedProfit: session.reservedProfit,
      step: session.step,
      gameData: session.gameData,
      gameState: session.gameState
    });
  }

  function _requireSessionExists(uint256 sessionId, Session storage session) private view {
    if (session.player == address(0)) revert LocalCasinoHost__SessionNotFound(sessionId);
  }

  function _requirePhase(uint256 sessionId, SessionPhase actual, SessionPhase expected) private pure {
    if (actual != expected) revert LocalCasinoHost__InvalidSessionPhase(sessionId, expected, actual);
  }

  function _isTerminalPhase(SessionPhase phase) private pure returns (bool) {
    return
      phase == SessionPhase.SETTLED || phase == SessionPhase.FORFEITED || phase == SessionPhase.CANCELLED;
  }
}
