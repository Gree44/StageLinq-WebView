export type DeckNumber = 1 | 2 | 3 | 4;

export interface DeckState {
  deck: DeckNumber;
  trackLoaded: boolean; // true only when a track is loaded to this deck
  title: string;
  artist: string;
  elapsedSec: number; // BeatInfo timeline (seconds)
  totalSec: number;   // TrackLength (seconds)
  currentBpm: number;
  trackBpm: number;   // derived (currentBpm / speed) when possible
  speed: number;      // 1.0 = normal
  keyIndex: number | null;
  keyCamelot: string; // derived display string
  fader: number;      // 0..1 (ExternalMixerVolume)
  play: boolean;
  updatedAt: number;  // ms
}

export interface SnapshotPayload {
  type: 'snapshot';
  seq: number;
  ts: number;
  decks: Record<DeckNumber, DeckState>;
}

export interface HelloPayload {
  type: 'hello';
  ts: number;
  version: string;
  fps: number;
}

export type WsPayload = HelloPayload | SnapshotPayload;
