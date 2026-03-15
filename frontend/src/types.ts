export type DeckNumber = 1 | 2 | 3 | 4;

export interface DeckState {
  deck: DeckNumber;
  title: string;
  artist: string;
  elapsedSec: number;
  totalSec: number;
  currentBpm: number;
  trackBpm: number;
  speedState: number;
  keyIndex: number | null;
  keyCamelot: string;
  fader: number;
  play: boolean;
  updatedAt: number;
}

export interface HelloPayload {
  type: 'hello';
  ts: number;
  version: string;
  fps: number;
}

export interface SnapshotPayload {
  type: 'snapshot';
  seq: number;
  ts: number;
  decks: Record<DeckNumber, DeckState>;
}

export type WsPayload = HelloPayload | SnapshotPayload;
