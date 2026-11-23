import type { AlertToneId } from '../../shared/types';

interface ToneStep {
  freq: number;
  delaySec: number;
  durationSec: number;
  type: OscillatorType;
  peakGain: number;
}

const TONE_PATTERNS: Record<Exclude<AlertToneId, 'silent'>, ToneStep[]> = {
  // Classic ascending triad
  chime: [
    { freq: 523.25, delaySec: 0, durationSec: 0.42, type: 'sine', peakGain: 0.13 },
    { freq: 659.25, delaySec: 0.14, durationSec: 0.42, type: 'sine', peakGain: 0.13 },
    { freq: 783.99, delaySec: 0.28, durationSec: 0.5, type: 'sine', peakGain: 0.14 },
  ],
  // Warm resonant bell
  'warm-bell': [
    { freq: 440, delaySec: 0, durationSec: 0.65, type: 'triangle', peakGain: 0.12 },
    { freq: 880, delaySec: 0.01, durationSec: 0.45, type: 'sine', peakGain: 0.06 },
    { freq: 554.37, delaySec: 0.24, durationSec: 0.7, type: 'triangle', peakGain: 0.12 },
  ],
  // High bright crystal focus chime
  crystal: [
    { freq: 880, delaySec: 0, durationSec: 0.32, type: 'sine', peakGain: 0.1 },
    { freq: 1108.73, delaySec: 0.11, durationSec: 0.34, type: 'sine', peakGain: 0.1 },
    { freq: 1318.51, delaySec: 0.22, durationSec: 0.45, type: 'sine', peakGain: 0.11 },
  ],
  // Crisp double alert pulse
  pulse: [
    { freq: 587.33, delaySec: 0, durationSec: 0.18, type: 'triangle', peakGain: 0.14 },
    { freq: 783.99, delaySec: 0.2, durationSec: 0.22, type: 'triangle', peakGain: 0.14 },
    { freq: 587.33, delaySec: 0.46, durationSec: 0.18, type: 'triangle', peakGain: 0.13 },
    { freq: 783.99, delaySec: 0.66, durationSec: 0.28, type: 'triangle', peakGain: 0.14 },
  ],
  // Low gentle plucked notes
  'gentle-oud': [
    { freq: 293.66, delaySec: 0, durationSec: 0.48, type: 'triangle', peakGain: 0.14 },
    { freq: 349.23, delaySec: 0.18, durationSec: 0.48, type: 'triangle', peakGain: 0.13 },
    { freq: 440, delaySec: 0.36, durationSec: 0.6, type: 'sine', peakGain: 0.13 },
  ],
};

export function playAlertTone(toneId: AlertToneId = 'chime'): void {
  if (toneId === 'silent') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const steps = TONE_PATTERNS[toneId] ?? TONE_PATTERNS.chime;
    const baseTime = ctx.currentTime + 0.02;
    let maxEnd = 0;

    for (const step of steps) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = baseTime + step.delaySec;
      const tEnd = t0 + step.durationSec;
      maxEnd = Math.max(maxEnd, step.delaySec + step.durationSec);

      osc.type = step.type;
      osc.frequency.setValueAtTime(step.freq, t0);

      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.exponentialRampToValueAtTime(step.peakGain, t0 + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(tEnd + 0.03);
    }

    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, Math.ceil((maxEnd + 0.35) * 1000));
  } catch {
    // Ignore browser audio autoplay restrictions prior to user gesture
  }
}
