import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { StageLinqBridge } from './stagelinqBridge.js';
import type { DeckNumber, SnapshotPayload, WsPayload } from './types.js';
import { ArtNetTimecodeBroadcaster } from './artnetTimecode.js';
import { States, StageLinqValue } from "@gree44/stagelinq";
import { logError, logLifecycle, logUiOut } from './logging.js';

function isIgnorableStageLinqError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    typeof err === 'string'
      ? err
      : ((err as any)?.message ?? String(err));

  const text = String(msg);
  return (
    text.includes('No broadcast targets have been found') ||
    text.includes("File Transfer Unhandled message id '6'")
  );
}

process.on('uncaughtException', (err: unknown) => {
  if (isIgnorableStageLinqError(err)) {
    logError('[StageLinq] Non-fatal library error. Continuing:', (err as any)?.message || err);
    return;
  }

  logError('Uncaught exception:', (err as any)?.message || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  if (isIgnorableStageLinqError(reason)) {
    logError('[StageLinq] Non-fatal library error. Continuing:', (reason as any)?.message || reason);
    return;
  }

  logError('Unhandled rejection:', (reason as any)?.message || reason);
  process.exit(1);
});

function ensureState(state: StageLinqValue) {
  if (!States.includes(state)) States.push(state);
}

// Total time (TrackLength) + KeyIndex (CurrentKeyIndex) for all decks
[
  StageLinqValue.EngineDeck1TrackTrackLength,
  StageLinqValue.EngineDeck2TrackTrackLength,
  StageLinqValue.EngineDeck3TrackTrackLength,
  StageLinqValue.EngineDeck4TrackTrackLength,

  StageLinqValue.EngineDeck1TrackCurrentKeyIndex,
  StageLinqValue.EngineDeck2TrackCurrentKeyIndex,
  StageLinqValue.EngineDeck3TrackCurrentKeyIndex,
  StageLinqValue.EngineDeck4TrackCurrentKeyIndex,
].forEach(ensureState);


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 8090);
const WS_FPS = 30;

interface ConfigTrack {
  song_index?: string;
  offset_sec?: number;
  offset_frame?: number;
}

interface RootConfig {
  current_playlist?: number;
  timecode?: {
    fps?: number;
    target_ip?: string;
    target_port?: number;
  };
  control_input?: {
    mode?: string;
    universe?: number;
    address?: number;
  };
  playlists?: Array<{
    name?: string;
    content?: ConfigTrack[];
  }>;
}

const RECENT_IPS_PATH = path.resolve(process.cwd(), '.stagelinq-recent-ips.json');

async function loadRecentStageLinqIps(): Promise<string[]> {
  try {
    const raw = await fs.readFile(RECENT_IPS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => typeof v === 'string' && v.trim().length > 0);
  } catch {
    return [];
  }
}

async function saveRecentStageLinqIps(ips: string[]): Promise<void> {
  try {
    await fs.writeFile(RECENT_IPS_PATH, JSON.stringify(ips, null, 2), 'utf8');
  } catch (e: any) {
    logError('[StageLinq] Failed to save recent IPs:', e?.message || e);
  }
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

async function loadRootConfig(): Promise<RootConfig | null> {
  const candidates = [
    path.resolve(process.cwd(), 'config.json'),
    path.resolve(__dirname, '../../config.json'),
  ];

  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(stripJsonComments(raw)) as RootConfig;
      logLifecycle(`[CONFIG] Loaded ${filePath}`);
      return parsed;
    } catch {
      // try next candidate
    }
  }

  logLifecycle('[CONFIG] No config.json found, using env/default values.');
  return null;
}

function normalizeTrackName(name: string): string {
  return path.basename(name.trim());
}

function buildTrackOffsetMap(cfg: RootConfig | null): Map<string, { offsetSec: number; offsetFrame: number }> {
  const map = new Map<string, { offsetSec: number; offsetFrame: number }>();
  const playlists = cfg?.playlists ?? [];

  // Priority: current playlist first, then all others as fallback.
  const currentIdx = Number(cfg?.current_playlist ?? -1);
  const ordered = playlists
    .map((pl, idx) => ({ pl, idx }))
    .sort((a, b) => (a.idx === currentIdx ? -1 : b.idx === currentIdx ? 1 : a.idx - b.idx));

  for (const { pl } of ordered) {
    for (const item of pl.content ?? []) {
      const key = normalizeTrackName(String(item.song_index ?? ''));
      if (!key || map.has(key)) continue;
      map.set(key, {
        offsetSec: Number(item.offset_sec ?? 0),
        offsetFrame: Number(item.offset_frame ?? 0),
      });
    }
  }

  return map;
}

function mapDmxToDeck(value: number): DeckNumber | null {
  if (value <= 50) return null;
  if (value <= 101) return 1;
  if (value <= 152) return 2;
  if (value <= 203) return 3;
  return 4;
}

function toAbsoluteDmxValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const v = Math.max(0, value);
  // sacn package payload is commonly 0..100 (relative). Convert to 0..255.
  if (v <= 100) return Math.round((v / 100) * 255);
  // already absolute scale
  return Math.min(255, Math.round(v));
}

function coerceDmxPayload(packet: any): number[] {
  const candidates = [
    packet?.payload,
    packet?.propertyValues,
    packet?.values,
    packet?.dmxData,
    packet?.data?.payload,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c.map((v) => Number(v) || 0);
    if (Buffer.isBuffer(c)) return Array.from(c);
    if (ArrayBuffer.isView(c)) {
      const view = c as ArrayBufferView;
      return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    if (c && typeof c === 'object') {
      const numericKeys = Object.keys(c).filter((k) => /^\d+$/.test(k));
      if (numericKeys.length > 0) {
        const out: number[] = [];
        for (const k of numericKeys) {
          const idx = Number(k);
          out[idx] = Number((c as any)[k]) || 0;
        }
        return out;
      }
    }
    if (c && typeof c === 'object' && Array.isArray((c as any).values)) {
      return (c as any).values.map((v: any) => Number(v) || 0);
    }
  }

  return [];
}

async function main() {
  const config = await loadRootConfig();
  const recentIps = await loadRecentStageLinqIps();
  if (recentIps.length > 0) {
    logLifecycle(`[StageLinq] Recent device IPs: ${recentIps.join(', ')}`);
  }

  // Art-Net settings from root config.json (env vars override).
  const artnetEnabled = (process.env.ARTNET_ENABLED ?? 'true').toLowerCase() !== 'false';
  const artnetTargetIp = process.env.ARTNET_TARGET_IP ?? config?.timecode?.target_ip ?? '255.255.255.255';
  const artnetPort = Number(process.env.ARTNET_PORT ?? config?.timecode?.target_port ?? 6454);
  const artnetDeck = (Number(process.env.ARTNET_DECK ?? 1) as 1 | 2 | 3 | 4);
  const artnetFps = Number(process.env.ARTNET_FPS ?? config?.timecode?.fps ?? 30);
  const artnetSendHz = Number(process.env.ARTNET_SEND_HZ ?? artnetFps);
  const artnetFpsType = 0x03;
  const artnetLatencyCompMs = Number(process.env.ARTNET_LATENCY_COMP_MS ?? 80);

  // Control-input settings from root config.json (env vars override).
  const controlMode = String(process.env.CONTROL_INPUT_MODE ?? config?.control_input?.mode ?? 'sacn').toLowerCase();
  const sacnUniverse = Number(process.env.SACN_UNIVERSE ?? config?.control_input?.universe ?? 20);
  const controlAddress = Number(process.env.SACN_ADDRESS ?? config?.control_input?.address ?? 1);
  const controlChannelIndex = Math.max(0, controlAddress - 1);

  const trackOffsets = buildTrackOffsetMap(config);

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

    const bridge = new StageLinqBridge({
      downloadDbSources: false,
      onDeviceIp: (ip) => {
        const next = [ip, ...recentIps.filter((x) => x !== ip)].slice(0, 5);
        recentIps.splice(0, recentIps.length, ...next);
        logLifecycle(`[StageLinq] Device IP detected: ${ip}`);
        void saveRecentStageLinqIps(recentIps);
      },
    });
  const require = createRequire(import.meta.url);

  const artnet = new ArtNetTimecodeBroadcaster({
    enabled: artnetEnabled,
    targetIp: artnetTargetIp,
    port: artnetPort,
    fps: artnetFps,
    sendHz: artnetSendHz,
    fpsType: artnetFpsType,
    deck: artnetDeck,
    latencyCompMs: artnetLatencyCompMs,
  });

  let selectedDeck: DeckNumber | null = null;
  const setSelectedDeck = (nextDeck: DeckNumber | null, reason: string) => {
    if (nextDeck === selectedDeck) return;
    selectedDeck = nextDeck;
    logLifecycle(`[DECK SELECT] ${selectedDeck ? `Deck ${selectedDeck}` : 'No deck selected'} (${reason})`);
  };

  // Control input from config (currently sACN mode supported).
  if (controlMode === 'sacn') {
    try {
      const sacn: any = require('sacn');
      const Receiver = sacn?.Receiver ?? sacn?.default?.Receiver;
      if (Receiver) {
        const sACN = new Receiver({ universes: [sacnUniverse] });

        sACN.on('packet', (packet: any) => {
          const payload = coerceDmxPayload(packet);
          // logLifecycle(`[sACN] Payload U${sacnUniverse} slots=${Math.max(0, payload.length - 1)}:`, payload);

          // sacn payload is usually 1-based (channel 1 at index 1). We also tolerate 0-based arrays.
          const dmxValue = Number(
            payload[controlAddress] ?? payload[controlChannelIndex]
          );
          if (!Number.isFinite(dmxValue)) return;

          const absoluteDmxValue = toAbsoluteDmxValue(dmxValue);

          const nextDeck = mapDmxToDeck(absoluteDmxValue);
          setSelectedDeck(nextDeck, `sACN U${sacnUniverse} CH${controlAddress}=${dmxValue} (abs ${absoluteDmxValue})`);
        });

        sACN.on('PacketCorruption', (err: any) => {
          logError('[sACN] PacketCorruption:', err?.message || err);
        });

        sACN.on('PacketOutOfOrder', (err: any) => {
          logError('[sACN] PacketOutOfOrder:', err?.message || err);
        });

        sACN.on('error', (err: any) => {
          logError('[sACN] Receiver error:', err?.message || err);
        });

        process.once('SIGINT', () => {
          try { sACN.close(); } catch {}
          process.exit(0);
        });
        process.once('SIGTERM', () => {
          try { sACN.close(); } catch {}
          process.exit(0);
        });

        logLifecycle(`[sACN] Listening Universe ${sacnUniverse}, Address ${controlAddress}`);
      } else {
        logError('[sACN] Receiver export not found. Deck select via sACN is disabled.');
      }
    } catch (e: any) {
      logError('[sACN] Failed to initialize receiver:', e?.message || e);
    }
  } else {
    setSelectedDeck(artnetDeck, `mode=${controlMode}`);
    logLifecycle(`[CONTROL] mode=${controlMode} not implemented, using fixed deck ${selectedDeck}.`);
  }

  // Connect StageLinq with basic retry loop
  while (true) {
    try {
      logLifecycle('Connecting to StageLinq...');
      await bridge.connect();
      logLifecycle('StageLinq connected.');
      break;
    } catch (e: any) {
      logError('StageLinq connect failed:', e?.message || e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await artnet.start(() => {
    if (!selectedDeck) return undefined;

    const deck = bridge.getDeck(selectedDeck);
      if (deck.play !== true) return undefined;

    const fileKey = normalizeTrackName(deck.fileName || '');
    const offset = trackOffsets.get(fileKey);
    // logLifecycle(
    //   `[TRACK MATCH] Deck ${selectedDeck} file="${deck.fileName}" key="${fileKey}" ` +
    //   `match=${offset ? 'exact' : 'none'}`
    // );
    if (!offset) return deck;

    const offsetSec = offset.offsetSec + offset.offsetFrame / artnetFps;
    return {
      ...deck,
      elapsedSec: Math.max(0, deck.elapsedSec + offsetSec),
      totalSec: Math.max(0, deck.totalSec + offsetSec),
    };
  });

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
      logUiOut('[UI OUT]', JSON.stringify(payload));
    }

    const msg = JSON.stringify(payload as WsPayload);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }, intervalMs);



  server.listen(PORT, '0.0.0.0', () => {
    logLifecycle(`Web UI: http://0.0.0.0:${PORT}/`);
    logLifecycle(`WS: ws://0.0.0.0:${PORT}/ws`);
  });
}

main().catch((e) => {
  logError('Fatal:', e?.message || e);
  process.exit(1);
});
