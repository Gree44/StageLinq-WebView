import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DeckNumber, DeckState, WsPayload } from './types';
import DeckCard from './DeckCard';

const DECKS: DeckNumber[] = [1, 2, 3, 4];

const blankDeck = (deck: DeckNumber): DeckState => ({
  deck,
  title: '—',
  artist: '—',
  elapsedSec: 0,
  totalSec: 0,
  currentBpm: 0,
  trackBpm: 0,
  speedState: 0,
  keyIndex: null,
  keyCamelot: '--',
  fader: 0,
  play: false,
  updatedAt: Date.now(),
});

export default function App() {
  const [decks, setDecks] = useState<Record<DeckNumber, DeckState>>({
    1: blankDeck(1),
    2: blankDeck(2),
    3: blankDeck(3),
    4: blankDeck(4),
  });
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(0);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws`;
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let retryT: number | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) retryT = window.setTimeout(connect, 800);
      };

      ws.onerror = () => {
        // onclose will follow
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsPayload;
          if (msg.type === 'snapshot') {
            if (msg.seq <= lastSeq.current) return;
            lastSeq.current = msg.seq;
            setDecks(msg.decks);
          }
        } catch {
          // ignore
        }
      };
    };

    connect();

    return () => {
      closedByUs = true;
      if (retryT) window.clearTimeout(retryT);
      try { ws?.close(); } catch { }
    };
  }, [wsUrl]);

  return (
    <div className="grid">
      {DECKS.map((d) => (
        <DeckCard
          key={d}
          deck={d}
          state={decks[d]}
          connected={connected}
        />
      ))}
    </div>
  );
}
