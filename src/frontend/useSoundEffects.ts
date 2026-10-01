import { useCallback, useEffect, useRef } from 'react';

export type SoundCue = 'ui-select' | 'wager-chip' | 'card-deal' | 'card-continue' | 'card-hit' | 'hit-chime' | 'card-loss' | 'loss-tone' | 'cashout-chips' | 'cashout-chime' | 'action-error' | 'toggle';

type AudioContextWithWebkit = typeof AudioContext & { new (): AudioContext };

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextConstructor = (window.AudioContext ?? (window as Window & { webkitAudioContext?: AudioContextWithWebkit }).webkitAudioContext) as typeof AudioContext | undefined;
  return AudioContextConstructor ? new AudioContextConstructor() : null;
}

function tone(context: AudioContext, destination: AudioNode, frequency: number, start: number, duration: number, volume: number, type: OscillatorType = 'sine', endFrequency = frequency) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playCue(context: AudioContext, cue: SoundCue, volume: number, pitch: number) {
  const now = context.currentTime + 0.01;
  const output = context.createGain();
  output.gain.value = volume;
  output.connect(context.destination);
  const note = (frequency: number, offset: number, duration: number, level = 0.16, type: OscillatorType = 'sine') => tone(context, output, frequency * pitch, now + offset, duration, level, type);

  switch (cue) {
    case 'ui-select': note(520, 0, 0.075, 0.2, 'triangle'); break;
    case 'wager-chip': note(740, 0, 0.06, 0.16, 'square'); note(980, 0.035, 0.07, 0.1); break;
    case 'toggle': note(460, 0, 0.06, 0.14, 'triangle'); note(700, 0.045, 0.08, 0.1, 'triangle'); break;
    case 'card-deal': note(180, 0, 0.16, 0.13, 'sawtooth'); note(360, 0.025, 0.19, 0.12, 'triangle'); break;
    case 'card-continue': note(260, 0, 0.14, 0.12, 'triangle'); note(420, 0.07, 0.18, 0.1, 'triangle'); break;
    case 'card-hit': note(300, 0, 0.12, 0.1, 'triangle'); note(600, 0.03, 0.14, 0.08); break;
    case 'hit-chime': note(523, 0, 0.22, 0.14); note(659, 0.08, 0.25, 0.12); note(784, 0.16, 0.32, 0.1); break;
    case 'card-loss': note(230, 0, 0.18, 0.14, 'sawtooth'); note(150, 0.04, 0.24, 0.1, 'triangle'); break;
    case 'loss-tone': note(220, 0, 0.28, 0.13); note(164, 0.13, 0.38, 0.1); break;
    case 'cashout-chips': note(420, 0, 0.12, 0.11, 'square'); note(560, 0.08, 0.12, 0.1, 'square'); note(740, 0.16, 0.14, 0.08, 'square'); break;
    case 'cashout-chime': note(523, 0, 0.22, 0.13); note(659, 0.09, 0.24, 0.12); note(784, 0.18, 0.26, 0.11); note(1047, 0.28, 0.5, 0.1); break;
    case 'action-error': note(210, 0, 0.12, 0.14, 'square'); note(160, 0.1, 0.18, 0.11, 'square'); break;
  }
  window.setTimeout(() => output.disconnect(), 900);
}

export function useSoundEffects(enabled: boolean, volume = 0.65) {
  const contextRef = useRef<AudioContext | null>(null);

  useEffect(() => () => {
    void contextRef.current?.close();
    contextRef.current = null;
  }, []);

  const play = useCallback((cue: SoundCue, pitch = 1, force = false) => {
    if ((!enabled && !force) || typeof window === 'undefined') return;
    const context = contextRef.current ?? getAudioContext();
    if (!context) return;
    contextRef.current = context;
    void context.resume().then(() => playCue(context, cue, Math.max(0, Math.min(1, volume)), pitch)).catch(() => {
      // Browsers can reject playback until the user has interacted with the page.
    });
  }, [enabled, volume]);

  return { play };
}
