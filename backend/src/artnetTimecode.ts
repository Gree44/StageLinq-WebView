import dgram from 'node:dgram';
import type { DeckState } from './types.js';

export interface ArtNetOptions {
  enabled: boolean;
  targetIp: string;
  port: number;
  fps: number;
  sendHz?: number;
  fpsType: number; // 0x00=24,0x01=25,0x02=29.97,0x03=30
  deck: 1 | 2 | 3 | 4;
  latencyCompMs?: number;
}

function buildArtNetTimecode(hours: number, minutes: number, seconds: number, frames: number, fpsType: number): Buffer {
  const buffer = Buffer.alloc(19);
  buffer.write('Art-Net\0', 0, 8, 'ascii');
  buffer.writeUInt16LE(0x9700, 8);
  buffer.writeUInt16BE(14, 10);
  buffer[14] = frames & 0xff;
  buffer[15] = seconds & 0xff;
  buffer[16] = minutes & 0xff;
  buffer[17] = hours & 0xff;
  buffer[18] = fpsType & 0xff;
  return buffer;
}

function framesToHMSF(totalFrames: number, fps: number) {
  const frames = ((totalFrames % fps) + fps) % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = ((totalSeconds % 60) + 60) % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = ((totalMinutes % 60) + 60) % 60;
  const hours = ((Math.floor(totalMinutes / 60) % 24) + 24) % 24;
  return { hours, minutes, seconds, frames };
}

export class ArtNetTimecodeBroadcaster {
  private socket = dgram.createSocket('udp4');
  private opts: ArtNetOptions;
  private loop: NodeJS.Timeout | null = null;
  private timelineFrames: number | null = null;
  private lastTickMs: number | null = null;

  constructor(opts: ArtNetOptions) {
    this.opts = opts;
  }

  async start(getDeckState: () => DeckState | undefined) {
    if (!this.opts.enabled) return;
    await new Promise<void>((resolve) => {
      this.socket.bind(() => {
        try { this.socket.setBroadcast(true); } catch {}
        resolve();
      });
    });

    const sendHz = Math.max(1, Number(this.opts.sendHz ?? this.opts.fps));
    const intervalMs = Math.max(1, Math.round(1000 / sendHz));
    this.loop = setInterval(() => {
      const deckState = getDeckState();
      if (!deckState) return;
      this.tick(deckState);
    }, intervalMs);

    console.log(`Art-Net TC enabled: ${this.opts.targetIp}:${this.opts.port} @ ${this.opts.fps}fps, send=${sendHz}Hz (deck ${this.opts.deck})`);
  }

  stop() {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    try { this.socket.close(); } catch {}
  }

  tick(deckState: DeckState) {
    if (!this.opts.enabled) return;

    const nowMs = Date.now();
    const sourceSec = Number(deckState.elapsedSec) || 0;
    const sourceFrames = Math.max(0, sourceSec * this.opts.fps);

    if (deckState.play !== true) {
      // Keep internal clock in sync but suppress output when paused/stopped.
      this.timelineFrames = sourceFrames;
      this.lastTickMs = null;
      return;
    }

    if (this.timelineFrames == null) {
      this.timelineFrames = sourceFrames;
    }

    // Warm-up tick: avoid emitting a single packet right when sender starts/resumes.
    if (this.lastTickMs == null) {
      this.lastTickMs = nowMs;
      this.timelineFrames = sourceFrames;
      return;
    }

    const dtSec = Math.max(0, (nowMs - this.lastTickMs) / 1000);
    this.timelineFrames += dtSec * this.opts.fps;

    // Re-sync on seeks/jumps to keep sender aligned with deck timeline.
    const drift = Math.abs(sourceFrames - this.timelineFrames);
    if (drift > this.opts.fps * 0.15) {
      this.timelineFrames = sourceFrames;
    }

    // Never trail behind the source while playing.
    if (this.timelineFrames < sourceFrames) {
      this.timelineFrames = sourceFrames;
    }

    this.lastTickMs = nowMs;

    const latencyCompFrames = (this.opts.fps * (this.opts.latencyCompMs ?? 80)) / 1000;
    let totalFrames = Math.max(0, Math.floor(this.timelineFrames + latencyCompFrames));

    // Prevent running past track end (can trigger after-roll warnings on some desks).
    const totalSec = Number(deckState.totalSec) || 0;
    if (totalSec > 0) {
      const maxFrame = Math.max(0, Math.floor(totalSec * this.opts.fps) - 1);
      totalFrames = Math.min(totalFrames, maxFrame);
    }

    // Send every loop tick (no frame-skipping), so receivers get continuous TC updates.

    const tc = framesToHMSF(totalFrames, this.opts.fps);
    const pkt = buildArtNetTimecode(tc.hours, tc.minutes, tc.seconds, tc.frames, this.opts.fpsType);
    this.socket.send(pkt, 0, pkt.length, this.opts.port, this.opts.targetIp);
  }
}
