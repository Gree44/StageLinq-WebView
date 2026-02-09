import React, { useMemo } from 'react';
import type { DeckNumber, DeckState } from './types';

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function formatMMSS(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${pad2(m)}:${pad2(r)}`;
}

function signedPercent(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) return '0.0%';
  const pct = (speed - 1) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export default function DeckCard(props: {
  deck: DeckNumber;
  state: DeckState;
  connected: boolean;
}) {
  const { deck, state, connected } = props;

  const themeClass = `theme-d${deck}`;
  const faderOnRight = deck === 1 || deck === 3;

  const elapsed = useMemo(() => formatMMSS(state.elapsedSec), [state.elapsedSec]);
  const total = useMemo(() => formatMMSS(state.totalSec), [state.totalSec]);
  const remaining = useMemo(() => formatMMSS(Math.max(0, state.totalSec - state.elapsedSec)), [state.totalSec, state.elapsedSec]);

  const bpm = Number.isFinite(state.currentBpm) ? state.currentBpm.toFixed(2) : '—';
  const trackBpm = Number.isFinite(state.trackBpm) && state.trackBpm > 0 ? state.trackBpm.toFixed(2) : '—';
  const rel = signedPercent(state.speed);

  const faderPct = Math.round((state.fader ?? 0) * 100);

  return (
    <div className={`card ${themeClass}`}>
      <div className="deckBorder" />

      <div className="cardHeader">
        <div className="art" title="Artwork (placeholder)">
          D{deck}
        </div>

        <div className="titleBlock">
          <div className="title" title={state.title}>
            {state.play ? <span className="playDot" /> : null}
            {state.title || '—'}
          </div>
          <div className="artist" title={state.artist}>{state.artist || '—'}</div>
        </div>

        <div className="stats">
          <div className="pills">
            <span className="pill">Key: <strong>{state.keyCamelot || '--'}</strong></span>
            <span className="pill">{connected ? 'LIVE' : 'OFFLINE'}</span>
          </div>

          <div className="kv">
            <div><span className="label">Elapsed / Total</span></div>
            <div><strong>{elapsed}</strong> / <strong>{total}</strong></div>
            <div className="label">Remaining: {remaining}</div>
          </div>
        </div>
      </div>

      <div className="middle">
        {!faderOnRight ? (
          <div className="fader" aria-label={`Deck ${deck} channel fader`}>
            <div className="faderTrack">
              <div className="faderFill" style={{ height: `${faderPct}%` }} />
            </div>
            <div className="faderPct">{faderPct}%</div>
          </div>
        ) : null}

        <div className="content">
          <div className="row">
            <div className="label">BPM</div>
            <div className="value">{bpm}</div>
          </div>
          <div className="row">
            <div className="label">Track BPM</div>
            <div className="value">{trackBpm}</div>
          </div>
          <div className="row">
            <div className="label">Relative</div>
            <div className="value">{rel}</div>
          </div>
        </div>

        {faderOnRight ? (
          <div className="fader" aria-label={`Deck ${deck} channel fader`}>
            <div className="faderTrack">
              <div className="faderFill" style={{ height: `${faderPct}%` }} />
            </div>
            <div className="faderPct">{faderPct}%</div>
          </div>
        ) : null}
      </div>

      <div className="waveform" title="Waveform placeholder" />
    </div>
  );
}
