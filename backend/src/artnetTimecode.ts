import dgram from 'node:dgram';
import type { DeckState } from './types.js';

export interface ArtNetOptions {
  enabled: boolean;
  targetIp: string;
  port: number;
  fps: number;
  fpsType: number; // 0x00=24,0x01=25,0x02=29.97,0x03=30
  deck: 1 | 2 | 3 | 4;
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
  private lastFrame: number | null = null;
  private opts: ArtNetOptions;

  constructor(opts: ArtNetOptions) {
    this.opts = opts;
  }

  async start() {
    if (!this.opts.enabled) return;
    await new Promise<void>((resolve) => {
      this.socket.bind(() => {
        try { this.socket.setBroadcast(true); } catch {}
        resolve();
      });
    });
    console.log(`Art-Net TC enabled: ${this.opts.targetIp}:${this.opts.port} @ ${this.opts.fps}fps (deck ${this.opts.deck})`);
  }

  stop() {
    try { this.socket.close(); } catch {}
  }

  tick(deckState: DeckState) {
    if (!this.opts.enabled) return;
    if (deckState.deck !== this.opts.deck) return;

    const seconds = Number(deckState.elapsedSec) || 0;
    const totalFrames = Math.floor(seconds * this.opts.fps);

    if (this.lastFrame === totalFrames) return;
    this.lastFrame = totalFrames;

    const tc = framesToHMSF(totalFrames, this.opts.fps);
    const pkt = buildArtNetTimecode(tc.hours, tc.minutes, tc.seconds, tc.frames, this.opts.fpsType);
    this.socket.send(pkt, 0, pkt.length, this.opts.port, this.opts.targetIp);
  }
}
