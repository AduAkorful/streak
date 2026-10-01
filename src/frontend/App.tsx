import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatUnits, parseUnits } from 'viem';
import type { HostSnapshotV1 } from '@chain/casino-sdk/guest';
import { computeMaxWager } from '@chain/casino-sdk/guest';

import {
  LINKS,
  MAX_HISTORY_LINKS,
  MAX_ODDS_PRODUCT,
  RTP_BPS,
  availableLinks,
  cashoutMultiplier,
  cashoutPayout,
  cardColor,
  cardRank,
  cardSuit,
  decodeGameState,
  encodeActionData,
  encodeGameData,
  isLinkAvailable,
  linkFactor,
  unpackCardHistory,
  unpackLinkHistory,
  type GameState,
  type Link,
} from '../shared/streak';
import { useCasinoHost } from './useCasinoHost';
import { useSoundEffects } from './useSoundEffects';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
const SUITS = ['♠', '♥', '♦', '♣'] as const;
const PHASE_WAITING_RANDOMNESS = 'WAITING_RANDOMNESS';
const PHASE_PLAYER_ACTION = 'WAITING_PLAYER_ACTION';
const TERMINAL_PHASES = new Set(['SETTLED', 'FORFEITED', 'CANCELLED']);

type SessionRow = HostSnapshotV1['sessions']['items'][number];
type Modal = 'help' | 'settings' | 'stats' | null;
type Round = { sessionKey: string; status: 'opening' | 'live' };

function displayCard(card: number) {
  return { rank: RANKS[cardRank(card)], suit: SUITS[cardSuit(card)], red: cardColor(card) === 1 };
}

function safeBigInt(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  try { return BigInt(value); } catch { return undefined; }
}

function phaseOf(row: SessionRow | undefined): string | undefined {
  if (!row) return undefined;
  if (row.phaseName) return row.phaseName;
  if (row.phase === 1) return PHASE_WAITING_RANDOMNESS;
  if (row.phase === 2) return PHASE_PLAYER_ACTION;
  if (row.phase === 3) return 'SETTLED';
  if (row.phase === 4) return 'FORFEITED';
  if (row.phase === 5) return 'CANCELLED';
  return undefined;
}

function decodeLiveState(row: SessionRow | undefined): { state: GameState | null; error: string | null } {
  if (!row) return { state: null, error: null };
  if (!row.raw.gameState) return { state: null, error: 'Waiting for the host to publish the live game state.' };
  try { return { state: decodeGameState(row.raw.gameState), error: null }; }
  catch { return { state: null, error: 'The host supplied an invalid game state. Waiting for a corrected snapshot.' }; }
}

function formatMoney(value: bigint | undefined, decimals: number | undefined, symbol: string | undefined): string {
  if (value === undefined || decimals === undefined) return '—';
  return `${formatUnits(value, decimals)} ${symbol ?? ''}`.trim();
}

function formatSelectionPrompt(missing: string[]): string {
  if (missing.length === 1) return `Select ${missing[0]}`;
  if (missing.length === 2) return `Select ${missing[0]} & ${missing[1]}`;
  return `Select ${missing.slice(0, -1).join(', ')} & ${missing.at(-1)}`;
}

function Icon({ name }: { name: 'settings' | 'stats' | 'help' | 'close' | 'minus' | 'plus' }) {
  const paths = {
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z" /></>,
    stats: <><path d="M5 20V10M12 20V4M19 20v-7" /></>,
    help: <><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-2.9 2.5-2.9 4M12 17h.01" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    minus: <path d="M5 12h14" />,
    plus: <><path d="M12 5v14M5 12h14" /></>,
  } as const;
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function PlayingCard({ card, faceDown, pendingLink, status }: { card?: number; faceDown?: boolean; pendingLink?: Link | null; status?: 'win' | 'loss' | 'idle' }) {
  if (faceDown || card === undefined) return <div className="playing-card face-down"><span> S </span></div>;
  const info = displayCard(card);
  return <div className={`playing-card ${info.red ? 'card-red' : 'card-black'} ${status ?? ''}`}>
    <div className="card-corner"><strong>{info.rank}</strong><span>{info.suit}</span></div>
    <span className="card-center-suit">{info.suit}</span>
    <div className="card-corner bottom"><strong>{info.rank}</strong><span>{info.suit}</span></div>
    {pendingLink && <span className={`card-link-indicator ${pendingLink}`}>{pendingLink}</span>}
  </div>;
}

function RouteChain({ state }: { state: GameState | null }) {
  if (!state) return <div className="route-chain empty">Live route appears after the first draw</div>;
  const cards = unpackCardHistory(state.packedCardHistory, state.cardCount);
  const links = unpackLinkHistory(state.packedLinkHistory, state.cardCount - 1);
  return <div className="route-chain" aria-label="Resolved route">
    {cards.map((card, index) => <span className="route-item" key={`${card}-${index}`}>
      {index > 0 && <><span className={`route-chain-link-tag ${links[index - 1]}`}>{links[index - 1][0].toUpperCase()}</span><span className="route-arrow">›</span></>}
      <span className={`mini-card ${cardColor(card) === 1 ? 'card-red' : 'card-black'}`}><strong>{RANKS[cardRank(card)]}</strong><span>{SUITS[cardSuit(card)]}</span></span>
    </span>)}
  </div>;
}

function LinkButton({ link, disabled, selected, meta, onClick }: { link: Link; disabled?: boolean; selected?: boolean; meta: string; onClick: () => void }) {
  return <button type="button" className={`link-btn ${link} ${selected ? 'selected' : ''}`} disabled={disabled} onClick={onClick}>
    <span>{link[0].toUpperCase() + link.slice(1)}</span><small>{meta}</small>
  </button>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="modal-overlay" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-header"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" /></button></div>
      {children}
    </section>
  </div>;
}

export function App() {
  const { hostApi, snapshot, connectionError } = useCasinoHost();
  const [anchorRank, setAnchorRank] = useState<number | null>(null);
  const [anchorSuit, setAnchorSuit] = useState<number | null>(null);
  const [firstLink, setFirstLink] = useState<Link | null>(null);
  const [wagerInput, setWagerInput] = useState('');
  const [round, setRound] = useState<Round | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem('streak.sound-enabled') !== 'false'; }
    catch { return true; }
  });
  const [turboEnabled, setTurboEnabled] = useState(false);
  const revealedSessions = useRef(new Set<string>());
  const announcedSessions = useRef(new Set<string>());
  const previousLiveState = useRef<{ sessionKey: string; phase?: string; cardCount: number; streakLength: number }>();
  const { play } = useSoundEffects(soundEnabled);

  const decimals = snapshot?.token.decimals;
  const symbol = snapshot?.token.symbol;
  const balance = safeBigInt(snapshot?.balances.smartVaultBalance);
  const anchorCard = anchorRank !== null && anchorSuit !== null ? anchorSuit * 13 + anchorRank : undefined;
  const wager = useMemo(() => {
    if (!wagerInput.trim() || decimals === undefined) return undefined;
    try { const value = parseUnits(wagerInput.trim(), decimals); return value > 0n ? value : undefined; } catch { return undefined; }
  }, [wagerInput, decimals]);
  const activeRow = useMemo(() => {
    if (!round || !snapshot) return undefined;
    return snapshot.sessions.items.find(row => row.sessionKey === round.sessionKey && row.gameAddress.toLowerCase() === snapshot.integration.gameAddress.toLowerCase());
  }, [round, snapshot]);
  const phase = phaseOf(activeRow);
  const { state: liveState, error: stateError } = decodeLiveState(activeRow);
  const terminal = Boolean(activeRow && (activeRow.isSettled || TERMINAL_PHASES.has(phase ?? '')));
  const resultWon = terminal && liveState !== null && liveState.streakLength === liveState.cardCount - 1;
  const liveWager = safeBigInt(activeRow?.wager);
  const payout = safeBigInt(activeRow?.payout);
  const maxAllowedReservedProfit = safeBigInt(snapshot?.casino?.maxAllowedReservedProfit);
  const platformMaxWager = useMemo(() => snapshot && decimals !== undefined
    ? computeMaxWager(snapshot, { maxMultiplierX: cashoutMultiplier(MAX_ODDS_PRODUCT) })
    : undefined, [snapshot, decimals]);
  const riskExceeded = wager !== undefined && maxAllowedReservedProfit !== undefined
    ? cashoutPayout(wager, MAX_ODDS_PRODUCT) - wager > maxAllowedReservedProfit
    : false;
  const invalidBalance = wager !== undefined && balance !== undefined && wager > balance;
  const walletReady = snapshot?.wallet.status === 'ready';
  const canOpen = Boolean(hostApi && snapshot && walletReady && balance !== undefined && anchorCard !== undefined && firstLink && wager && !invalidBalance && !riskExceeded && !round && decimals !== undefined);
  const available = liveState ? availableLinks(liveState.oddsProduct) : [];

  useEffect(() => {
    if (!activeRow || !terminal || !liveState || payout === undefined || revealedSessions.current.has(activeRow.sessionKey)) return;
    revealedSessions.current.add(activeRow.sessionKey);
    void hostApi?.revealOutcome({ sessionId: activeRow.sessionId }).catch(() => {});
  }, [activeRow, terminal, liveState, payout, hostApi]);

  useEffect(() => {
    if (!activeRow) return;
    if (!announcedSessions.current.has(activeRow.sessionKey)) {
      announcedSessions.current.add(activeRow.sessionKey);
      play('card-deal');
    }
    if (!liveState) return;

    const previous = previousLiveState.current;
    if (previous?.sessionKey === activeRow.sessionKey) {
      if (
        previous.phase === PHASE_WAITING_RANDOMNESS &&
        phase === PHASE_PLAYER_ACTION &&
        liveState.cardCount > previous.cardCount &&
        liveState.streakLength > previous.streakLength
      ) {
        const pitch = 1 + Math.min(liveState.streakLength, 8) * 0.04;
        play('card-hit');
        play('hit-chime', pitch);
      }
      if (previous.phase === PHASE_PLAYER_ACTION && phase === PHASE_WAITING_RANDOMNESS) {
        play('card-continue');
      }
      if (!previous.phase?.startsWith('SETTLED') && terminal) {
        if (resultWon) {
          play('cashout-chips');
          play('cashout-chime');
        } else {
          play('card-loss');
          play('loss-tone');
        }
      }
    }
    previousLiveState.current = {
      sessionKey: activeRow.sessionKey,
      phase,
      cardCount: liveState.cardCount,
      streakLength: liveState.streakLength,
    };
  }, [activeRow, liveState, phase, terminal, resultWon, play]);

  const openSession = useCallback(async () => {
    if (!hostApi || !snapshot || !canOpen || anchorCard === undefined || !firstLink || !wager) return;
    setError(null);
    setRound({ sessionKey: `opening:${Date.now()}`, status: 'opening' });
    try {
      const result = await hostApi.openSession({ wager: wager.toString(), gameData: encodeGameData({ anchorCard, firstLink }), randomnessRequestData: '0x' });
      setRound({ sessionKey: result.sessionKey, status: 'live' });
    } catch (cause) {
      play('action-error');
      setRound(null);
      setError(cause instanceof Error ? cause.message : 'The host rejected this wager.');
    }
  }, [hostApi, snapshot, canOpen, anchorCard, firstLink, wager, play]);

  const submitLink = useCallback(async (link: Link) => {
    if (!hostApi || !activeRow || !liveState || actionPending || !isLinkAvailable(liveState.oddsProduct, link)) return;
    setActionPending(true);
    setError(null);
    try { await hostApi.submitAction({ sessionId: activeRow.sessionId, actionData: encodeActionData({ kind: 'continue', link }), randomnessRequestData: '0x' }); }
    catch (cause) { play('action-error'); setError(cause instanceof Error ? cause.message : 'The continuation was rejected.'); }
    finally { setActionPending(false); }
  }, [hostApi, activeRow, liveState, actionPending, play]);

  const cashOut = useCallback(async () => {
    if (!hostApi || !activeRow || !liveState || actionPending) return;
    setActionPending(true);
    setError(null);
    try { await hostApi.submitAction({ sessionId: activeRow.sessionId, actionData: encodeActionData({ kind: 'cashout' }), randomnessRequestData: '0x' }); }
    catch (cause) { play('action-error'); setError(cause instanceof Error ? cause.message : 'Cash-out was rejected.'); }
    finally { setActionPending(false); }
  }, [hostApi, activeRow, liveState, actionPending, play]);

  const settledRows = useMemo(() => snapshot?.sessions.items.filter(row => row.gameAddress.toLowerCase() === snapshot.integration.gameAddress.toLowerCase() && (row.isSettled || TERMINAL_PHASES.has(phaseOf(row) ?? ''))) ?? [], [snapshot]);
  const stats = useMemo(() => {
    let bestStreak = 0; let maxMultiplier = 0; let links = 0; let wins = 0;
    for (const row of settledRows) {
      if (!row.raw.gameState) continue;
      try {
        const state = decodeGameState(row.raw.gameState);
        bestStreak = Math.max(bestStreak, state.streakLength);
        links += Math.max(0, state.cardCount - 1); wins += state.streakLength;
        const rowWager = safeBigInt(row.wager); const rowPayout = safeBigInt(row.payout);
        if (rowWager && rowPayout) maxMultiplier = Math.max(maxMultiplier, Number(rowPayout * 10000n / rowWager) / 10000);
      } catch { /* malformed rows are excluded from live statistics */ }
    }
    return { bestStreak, maxMultiplier, rounds: settledRows.length, winRate: links ? Math.round((wins / links) * 100) : 0 };
  }, [settledRows]);

  if (!hostApi || !snapshot) return <BlockedState message={connectionError ?? 'Connecting to the live casino host…'} />;
  const sessionSyncError = round?.status === 'live' && !activeRow ? 'Waiting for the host to publish this session.' : null;
  const terminalDataError = terminal && payout === undefined ? 'Waiting for the host to publish the final payout.' : null;
  const phaseDataError = round?.status === 'live' && activeRow && !phase ? 'The host supplied an unknown session phase.' : null;
  const blockedMessage = error ?? sessionSyncError ?? stateError ?? terminalDataError ?? phaseDataError ?? (!decimals ? 'Token metadata is not available yet.' : balance === undefined ? 'Token balance is not available yet.' : !walletReady ? walletMessage(snapshot.wallet.status) : null);
  const isOpening = round?.status === 'opening';
  const isWaiting = phase === PHASE_WAITING_RANDOMNESS;
  const isAction = phase === PHASE_PLAYER_ACTION && liveState !== null;
  const previewCard = anchorCard;

  return <main className={`app-shell ${terminal ? resultWon ? 'win-state' : 'loss-state' : ''}`} data-theme={snapshot.ui.theme}>
    <Header onSettings={() => setModal('settings')} onStats={() => setModal('stats')} onHelp={() => setModal('help')} />
    <MultiplierPanel state={liveState} phase={phase} />
    <section className="card-arena"><PlayingCard card={terminal || isWaiting || isAction ? liveState?.anchorCard : previewCard} faceDown={!liveState && !isOpening} pendingLink={liveState?.pendingLink} status={terminal ? resultWon ? 'win' : 'loss' : 'idle'} /><RouteChain state={liveState} /></section>
    {blockedMessage && <BlockedState message={blockedMessage} compact />}
    {!blockedMessage && !round && <WagerPanel rank={anchorRank} suit={anchorSuit} selectedLink={firstLink} wagerInput={wagerInput} decimals={decimals} symbol={symbol} balance={balance} maxWager={platformMaxWager} onRank={value => { play('ui-select'); setAnchorRank(value); }} onSuit={value => { play('ui-select'); setAnchorSuit(value); }} onLink={value => { play('ui-select'); setFirstLink(value); }} onWager={setWagerInput} onWagerStep={value => { play('wager-chip'); setWagerInput(value); }} onOpen={() => void openSession()} canOpen={canOpen} />}
    {!blockedMessage && round && (isOpening || isWaiting) && <WaitingPanel state={liveState} opening={isOpening} />}
    {!blockedMessage && round && isAction && <ActionPanel state={liveState!} wager={liveWager} decimals={decimals} symbol={symbol} disabled={actionPending} available={available} onCashOut={() => void cashOut()} onContinue={link => void submitLink(link)} />}
    {!blockedMessage && terminal && liveState && payout !== undefined && <SettlementOverlay won={resultWon} payout={payout} wager={liveWager} decimals={decimals} symbol={symbol} onAgain={() => { setRound(null); setAnchorRank(null); setAnchorSuit(null); setFirstLink(null); setWagerInput(''); }} />}
    {modal === 'help' && <Modal title="How to play Streak" onClose={() => setModal(null)}><Rules /></Modal>}
    {modal === 'settings' && <Modal title="Game settings" onClose={() => setModal(null)}><Settings sound={soundEnabled} turbo={turboEnabled} onSound={value => { play('toggle', 1, true); setSoundEnabled(value); try { localStorage.setItem('streak.sound-enabled', String(value)); } catch {} }} onTurbo={setTurboEnabled} /></Modal>}
    {modal === 'stats' && <Modal title="Session stats & fairness" onClose={() => setModal(null)}><Stats stats={stats} chainId={snapshot.integration.chainId} gameAddress={snapshot.integration.gameAddress} /></Modal>}
  </main>;
}

function walletMessage(status: HostSnapshotV1['wallet']['status']) { return status === 'disconnected' ? 'Connect your wallet in the host app to play.' : status === 'setup-required' ? 'Finish setting up your Smart Vault in the host app to play.' : 'Restore your host session key before betting.'; }

function BlockedState({ message, compact }: { message: string; compact?: boolean }) { return <div className={`blocked-state ${compact ? 'compact' : ''}`} role="status"><span className="blocked-dot" /><span>{message}</span></div>; }

function Header({ onSettings, onStats, onHelp }: { onSettings: () => void; onStats: () => void; onHelp: () => void }) { return <header className="header"><button className="icon-button" aria-label="Settings" onClick={onSettings}><Icon name="settings" /></button><div className="brand"><span className="brand-mark">✦</span><span>STREAK</span></div><div className="header-actions"><button className="icon-button" aria-label="Session statistics" onClick={onStats}><Icon name="stats" /></button><button className="icon-button" aria-label="How to play" onClick={onHelp}><Icon name="help" /></button></div></header>; }

function MultiplierPanel({ state, phase }: { state: GameState | null; phase?: string }) { const multiplier = state && state.oddsProduct > 1 ? cashoutMultiplier(state.oddsProduct) : 0; return <section className="multiplier-section"><div className="multiplier-badge"><strong>{multiplier.toFixed(2)}</strong><span>×</span></div><p>{state ? state.streakLength ? 'Route in progress' : 'Waiting for first draw' : phase ? 'Syncing live route' : 'Place a wager to begin'}</p><div className="streak-pips">{Array.from({ length: MAX_HISTORY_LINKS }, (_, index) => <span className={state && index < state.streakLength ? 'filled' : state && index === state.streakLength && phase === 'SETTLED' ? 'failed' : ''} key={index} />)}</div></section>; }

function WagerPanel({ rank, suit, selectedLink, wagerInput, decimals, symbol, balance, maxWager, onRank, onSuit, onLink, onWager, onWagerStep, onOpen, canOpen }: { rank: number | null; suit: number | null; selectedLink: Link | null; wagerInput: string; decimals?: number; symbol?: string; balance?: bigint; maxWager?: bigint; onRank: (value: number) => void; onSuit: (value: number) => void; onLink: (value: Link) => void; onWager: (value: string) => void; onWagerStep: (value: string) => void; onOpen: () => void; canOpen: boolean }) {
  const parsedWager = decimals !== undefined && wagerInput ? (() => { try { return parseUnits(wagerInput, decimals); } catch { return undefined; } })() : undefined;
  const step = decimals !== undefined ? formatUnits(10n ** BigInt(Math.max(decimals - 2, 0)), decimals) : '';
  const missingSelections = [
    rank === null || suit === null ? 'card' : null,
    selectedLink === null ? 'link' : null,
    parsedWager === undefined || parsedWager <= 0n ? 'wager' : null,
  ].filter((selection): selection is string => selection !== null);
  const dealLabel = canOpen
    ? 'Deal'
    : missingSelections.length > 0
      ? formatSelectionPrompt(missingSelections)
      : 'Deal unavailable';
  const adjust = (direction: 1 | -1) => { if (decimals === undefined) return; const current = parsedWager ?? 0n; const unit = 10n ** BigInt(Math.max(decimals - 2, 0)); const next = current + unit * BigInt(direction); if (next > 0n) onWagerStep(formatUnits(next, decimals)); };
  return <section className="controls wager-controls"><p className="eyebrow">1. Choose your anchor card</p><div className="rank-picker">{RANKS.map((label, value) => <button type="button" className={rank === value ? 'chip selected' : 'chip'} key={label} onClick={() => onRank(value)}>{label}</button>)}</div><div className="suit-picker">{SUITS.map((label, value) => <button type="button" className={`suit-chip ${value === 1 || value === 2 ? 'red' : ''} ${suit === value ? 'selected' : ''}`} key={label} onClick={() => onSuit(value)}>{label}</button>)}</div><div className="wager-row"><button type="button" className="icon-button small" aria-label="Decrease wager" onClick={() => adjust(-1)}><Icon name="minus" /></button><label><span>{symbol ?? 'Amount'}</span><input aria-label="Wager amount" inputMode="decimal" value={wagerInput} placeholder={decimals === undefined ? 'Loading…' : '0.00'} onChange={event => onWager(event.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} /></label><button type="button" className="icon-button small" aria-label="Increase wager" onClick={() => adjust(1)}><Icon name="plus" /></button></div><p className="balance-line">Balance: {formatMoney(balance, decimals, symbol)}{maxWager !== undefined && <span>Max: {formatMoney(maxWager, decimals, symbol)}</span>}{step && <span>Step: {step}</span>}</p><p className="eyebrow">2. Select prediction link</p><div className="link-buttons">{LINKS.map(link => <LinkButton key={link} link={link} selected={selectedLink === link} meta={`1/${linkFactor(link)} · ${parsedWager && decimals !== undefined ? formatMoney(cashoutPayout(parsedWager, linkFactor(link)), decimals, symbol) : '—'}`} onClick={() => onLink(link)} />)}</div><button type="button" className="deal-btn" disabled={!canOpen} onClick={onOpen}>{dealLabel}</button></section>;
}

function WaitingPanel({ state, opening }: { state: GameState | null; opening: boolean }) { return <section className="controls status-panel"><div className="odds-bar"><span><strong>{opening ? 'OPENING' : state?.pendingLink?.toUpperCase() ?? 'SYNCING'}</strong>{opening ? 'Signing wager' : 'Predicting'}</span><span><strong>{state?.pendingLink ? `1/${linkFactor(state.pendingLink)}` : '—'}</strong>Probability</span><span><strong>{state?.pendingLink && state.oddsProduct ? `${cashoutMultiplier(state.oddsProduct * linkFactor(state.pendingLink)).toFixed(2)}×` : '—'}</strong>If hit</span></div><div className="waiting-copy"><span className="spinner" />Waiting for on-chain VRF</div></section>; }

function ActionPanel({ state, wager, decimals, symbol, disabled, available, onCashOut, onContinue }: { state: GameState; wager?: bigint; decimals?: number; symbol?: string; disabled: boolean; available: Link[]; onCashOut: () => void; onContinue: (link: Link) => void }) { const payout = wager && state.oddsProduct > 1 ? cashoutPayout(wager, state.oddsProduct) : undefined; return <section className="controls action-panel"><button type="button" className="cashout-btn" disabled={disabled} onClick={onCashOut}>Cash out <strong>{formatMoney(payout, decimals, symbol)}</strong></button><div className="link-buttons">{LINKS.map(link => <LinkButton key={link} link={link} disabled={disabled || !available.includes(link)} meta={available.includes(link) ? `→ ${state.oddsProduct * linkFactor(link) <= MAX_ODDS_PRODUCT ? cashoutMultiplier(state.oddsProduct * linkFactor(link)).toFixed(2) : '—'}×` : 'Locked'} onClick={() => onContinue(link)} />)}</div></section>; }

function SettlementOverlay({ won, payout, wager, decimals, symbol, onAgain }: { won: boolean; payout: bigint; wager?: bigint; decimals?: number; symbol?: string; onAgain: () => void }) { return <section className={`settlement ${won ? 'won' : 'lost'}`}><div className="settlement-card"><span className="settlement-mark">{won ? '✦' : '×'}</span><h2>{won ? 'You won' : 'Streak broken'}</h2><strong>{won ? `+${formatMoney(payout, decimals, symbol)}` : `-${formatMoney(wager, decimals, symbol)}`}</strong><p>{won ? `Total payout at ${wager && payout ? (Number(payout * 10000n / wager) / 10000).toFixed(2) : '—'}× multiplier` : 'The drawn card did not match your link.'}</p><button type="button" className="deal-btn" onClick={onAgain}>Play again</button></div></section>; }

function Rules() { return <div className="modal-body"><p>Choose any anchor card, select a link, and wager from your live host balance.</p><table><thead><tr><th>Link</th><th>Match</th><th>Chance</th><th>Factor</th></tr></thead><tbody>{LINKS.map(link => <tr key={link}><td className={link}>{link[0].toUpperCase() + link.slice(1)}</td><td>{link === 'color' ? 'Same red/black' : link === 'suit' ? 'Same suit' : 'Same rank'}</td><td>1/{linkFactor(link)}</td><td>{linkFactor(link)}×</td></tr>)}</tbody></table><p>After every successful draw, cash out or choose another available link. The route cap is {MAX_ODDS_PRODUCT}, with a {Number(RTP_BPS) / 100}% RTP applied once to the complete payout.</p></div>; }
function Settings({ sound, turbo, onSound, onTurbo }: { sound: boolean; turbo: boolean; onSound: (value: boolean) => void; onTurbo: (value: boolean) => void }) { return <div className="modal-body"><Toggle label="Sound effects" value={sound} onChange={onSound} /><Toggle label="Fast deal / turbo" value={turbo} onChange={onTurbo} /></div>; }
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) { return <label className="setting-row"><span>{label}</span><button type="button" className={`toggle ${value ? 'active' : ''}`} aria-pressed={value} onClick={() => onChange(!value)}><span /></button></label>; }
function Stats({ stats, chainId, gameAddress }: { stats: { bestStreak: number; maxMultiplier: number; rounds: number; winRate: number }; chainId: number; gameAddress: string }) { return <div className="modal-body"><div className="stats-grid"><div><strong>{stats.bestStreak}</strong><span>Best streak</span></div><div><strong>{stats.maxMultiplier.toFixed(2)}×</strong><span>Max multiplier</span></div><div><strong>{stats.rounds}</strong><span>Rounds settled</span></div><div><strong>{stats.winRate}%</strong><span>Link win rate</span></div></div><div className="protocol-info"><strong>Live protocol data</strong><span>Chain {chainId}</span><span>{gameAddress}</span><span>{Number(RTP_BPS) / 100}% RTP · on-chain VRF</span></div></div>; }
