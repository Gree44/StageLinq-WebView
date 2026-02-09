import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { StageLinqBridge } from './stagelinqBridge.js';
import type { DeckNumber, SnapshotPayload, WsPayload } from './types.js';
import { ArtNetTimecodeBroadcaster } from './artnetTimecode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 8090);
const WS_FPS = 30;




// Optional Art-Net timecode (kept for compatibility with your existing bridge)
const ARTNET_ENABLED = (process.env.ARTNET_ENABLED ?? 'true').toLowerCase() !== 'false';
const ARTNET_TARGET_IP = process.env.ARTNET_TARGET_IP ?? '255.255.255.255';
const ARTNET_PORT = Number(process.env.ARTNET_PORT ?? 6454);
const ARTNET_DECK = (Number(process.env.ARTNET_DECK ?? 1) as 1 | 2 | 3 | 4);
const ARTNET_FPS = 30;
const ARTNET_FPS_TYPE = 0x03;

async function main() {
  const app = express();
  app.use(cors());

  // API health
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // Serve frontend build if present
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const bridge = new StageLinqBridge({ downloadDbSources: false });

  const artnet = new ArtNetTimecodeBroadcaster({
    enabled: ARTNET_ENABLED,
    targetIp: ARTNET_TARGET_IP,
    port: ARTNET_PORT,
    fps: ARTNET_FPS,
    fpsType: ARTNET_FPS_TYPE,
    deck: ARTNET_DECK,
  });

  // Connect StageLinq with basic retry loop
  while (true) {
    try {
      console.log('Connecting to StageLinq…');
      await bridge.connect();
      console.log('StageLinq connected.');
      break;
    } catch (e: any) {
      console.error('StageLinq connect failed:', e?.message || e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await artnet.start();

  let seq = 0;
  const clients = new Set<any>();

  wss.on('connection', (ws) => {
    clients.add(ws);

    const hello: WsPayload = { type: 'hello', ts: Date.now(), version: '0.1.0', fps: WS_FPS };
    ws.send(JSON.stringify(hello));

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  // --- UI snapshot logging (only when meaningful fields change) ---
  let lastComparable = '';

  function makeComparableSnapshot(p: SnapshotPayload) {
    // strip volatile fields so we don't log at 30Hz for timestamps, seq, etc.
    const decks: any = {};
    for (const [k, v] of Object.entries(p.decks)) {
      const d: any = { ...(v as any) };
      delete d.updatedAt;

      // elapsedSec changes continuously -> uncomment to include it in change detection
      delete d.elapsedSec;

      decks[k] = d;
    }

    return {
      type: p.type,
      decks,
    };
  }


  // Broadcast snapshots at 30Hz
  // Broadcast snapshots at 30Hz
  const intervalMs = Math.round(1000 / WS_FPS);
  setInterval(() => {
    const decks = bridge.getDecks();

    // feed Art-Net (selected deck)
    artnet.tick(decks[ARTNET_DECK as DeckNumber]);

    const payload: SnapshotPayload = {
      type: 'snapshot',
      seq: ++seq,
      ts: Date.now(),
      decks,
    };

    // Log only when meaningful values changed
    const comparableStr = JSON.stringify(makeComparableSnapshot(payload));
    if (comparableStr !== lastComparable) {
      lastComparable = comparableStr;
      console.log('[UI OUT]', JSON.stringify(payload));
    }

    const msg = JSON.stringify(payload as WsPayload);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }, intervalMs);



  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Web UI: http://0.0.0.0:${PORT}/`);
    console.log(`WS: ws://0.0.0.0:${PORT}/ws`);
  });
}

main().catch((e) => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
