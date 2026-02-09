import type { DeckNumber, DeckState } from "./types.js";
import { keyIndexToCamelot } from "./camelot.js";

import * as pkg from "@gree44/stagelinq";

// Resolve StageLinq export shape (some versions export default, some export { StageLinq }).
const StageLinq: any = (pkg as any).StageLinq ?? (pkg as any).default ?? pkg;

const DECKS: DeckNumber[] = [1, 2, 3, 4];

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export interface BridgeOptions {
  downloadDbSources?: boolean; // kept for compatibility; unused by this library
}

export class StageLinqBridge {
  private decks: Record<DeckNumber, DeckState>;

  // Track last known playback state per deck to print only changes (optional logging)
  private lastPlay: Record<DeckNumber, boolean | undefined> = {
    1: undefined,
    2: undefined,
    3: undefined,
    4: undefined,
  };

  // One-time discovery logs (so we can confirm which paths your device emits)
  private seen = {
    elapsed: false,
    total: false,
    key: false,
    speed: false,
    fader: false,
  };

  // Sample rate comes from StateMap: /Engine/DeckX/Track/SampleRate
  private sampleRateHz: Record<DeckNumber, number | null> = {
    1: null,
    2: null,
    3: null,
    4: null,
  };



  constructor(_opts: BridgeOptions = {}) {
    this.decks = Object.fromEntries(
      DECKS.map((d) => [d, this.blankDeck(d)])
    ) as Record<DeckNumber, DeckState>;

    this.wire();
  }

  private blankDeck(deck: DeckNumber): DeckState {
    return {
      deck,
      title: "—",
      artist: "—",
      elapsedSec: 0,
      totalSec: 0,
      currentBpm: 0,
      trackBpm: 0,
      speed: 1,
      keyIndex: null,
      keyCamelot: "--",
      fader: 0,
      play: false,
      updatedAt: Date.now(),
    };
  }

  private touch(deck: DeckNumber) {
    this.decks[deck].updatedAt = Date.now();
  }

  private recomputeDerived(deck: DeckNumber) {
    const ds = this.decks[deck];
    ds.keyCamelot = keyIndexToCamelot(ds.keyIndex);

    if (!this.seen.key && ds.keyIndex != null) {
      this.seen.key = true;
      console.log("[DISCOVER] KeyIndex value:", ds.keyIndex, "->", ds.keyCamelot);
    }


    // Track BPM derived from current BPM and speed (speed is ratio, e.g. 1.012).
    if (
      Number.isFinite(ds.speed) &&
      ds.speed > 0.0001 &&
      Number.isFinite(ds.currentBpm)
    ) {
      ds.trackBpm = ds.currentBpm / ds.speed;
    } else {
      ds.trackBpm = 0;
    }
  }

  private coerceBool(v: any): boolean | undefined {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "playing" || s === "play") return true;
      if (s === "false" || s === "0" || s === "stopped" || s === "stop" || s === "pause") return false;
    }
    return undefined;
  }

  private maybeLogPlayChange(deck: DeckNumber, isPlaying: boolean | undefined) {
    if (typeof isPlaying !== "boolean") return;

    const prev = this.lastPlay[deck];
    if (prev === undefined) {
      // initialize without logging
      this.lastPlay[deck] = isPlaying;
      return;
    }

    if (prev !== isPlaying) {
      this.lastPlay[deck] = isPlaying;
      console.log(`[Playback] Deck ${deck}: ${isPlaying ? "START" : "STOP"}`);
    }
  }

  private wire() {
    const devices = StageLinq.devices;

    // Different versions use different lifecycle event names; listen to both.
    devices.on?.("ready", (info: any) => {
      const name = info?.software?.name || "";
      console.log(`StageLinq ready ${name ? `(${name})` : ""}`);
    });

    devices.on?.("connected", (info: any) => {
      console.log(
        `StageLinq connected: ${info?.address || ""} ${info?.software?.name || ""}`
      );
    });

    devices.on?.("deviceConnected", (info: any) => {
      console.log(
        `StageLinq deviceConnected: ${info?.address || ""} ${info?.software?.name || ""}`
      );
    });

    devices.on?.("error", (e: any) => {
      console.error("StageLinq error:", e?.message || e);
    });

    /**
     * Low-level StateMap messages (raw). This is where /Engine/DeckX/Play and /PlayState appear.
     * Your observed payload is typically:
     *   { name: "/Engine/Deck1/Play", json: { state: true, type: 1 } }
     * i.e. boolean is in json.state (NOT json.value).
     */
    devices.on?.("message", (_info: any, data: any) => {
      const msg = data?.message ?? data;

      const name = msg?.name ?? msg?.path ?? msg?.key;
      if (!name) return;

      // normalize once
      const json = msg?.json ?? msg?.value ?? msg;

      const rawValue =
        json?.value ??
        json?.state ??
        json?.bool ??
        json?.number ??
        json?.string ??
        json?.text ??
        json;

      // ---- Mixer channel faders (volume) ----
      // Prime mixers often publish channel faders under /Engine/Mixer/ChannelX/...
      // ---- Mixer channel faders (volume) ----
      const mixerMatch = String(name).match(/^\/Engine\/Mixer\/Channel([1-4])\/(.+)$/);
      if (mixerMatch) {
        const ch = Number(mixerMatch[1]) as DeckNumber;
        const leaf = mixerMatch[2];

        // Typical fader leaves contain "Fader" or "Volume"
        if ((/fader/i.test(leaf) || /volume/i.test(leaf)) && typeof rawValue === "number") {
          this.decks[ch].fader = clamp01(rawValue);
          this.touch(ch);
          if (!this.seen.fader) {
            this.seen.fader = true;
            console.log("[DISCOVER] Fader path:", name, "=", rawValue);
          }
        }
        return;
      }

      // ---- Deck-related paths ----
      const m = String(name).match(/^\/Engine\/Deck([1-4])\/(.+)$/);
      if (!m) return;

      const deck = Number(m[1]) as DeckNumber;
      if (!DECKS.includes(deck)) return;

      const tail = m[2];
      const ds = this.decks[deck];

      // ---- SampleRate (needed for BeatInfo samples -> seconds) ----
      if ((/Track\/SampleRate$/i.test(tail) || /SampleRate$/i.test(tail)) && typeof rawValue === "number") {
        if (Number.isFinite(rawValue) && rawValue > 0) {
          this.sampleRateHz[deck] = rawValue;
          if (!this.seen.elapsed) {
            console.log("[DISCOVER] SampleRate path:", name, "=", rawValue);
          }
        }
      }


      // ---- Total seconds ----
      if ((/TrackLength$/i.test(tail) || /Track\/TrackLength$/i.test(tail)) && typeof rawValue === "number") {
        ds.totalSec = Math.max(0, rawValue);
        this.touch(deck);
        if (!this.seen.total) {
          this.seen.total = true;
          console.log("[DISCOVER] TotalSec path:", name, "=", rawValue);
        }
      }

      // ---- Key index ----
      if ((/KeyIndex$/i.test(tail) || /CurrentKey/i.test(tail)) && typeof rawValue === "number") {
        ds.keyIndex = rawValue;
        this.recomputeDerived(deck);
        this.touch(deck);
        if (!this.seen.key) {
          this.seen.key = true;
          console.log("[DISCOVER] KeyIndex path:", name, "=", rawValue);
        }
      }

      // ---- Speed (pitch ratio) ----
      if ((/Speed$/i.test(tail) || /Track\/Speed$/i.test(tail)) && typeof rawValue === "number") {
        ds.speed = rawValue;
        this.recomputeDerived(deck);
        this.touch(deck);
        if (!this.seen.speed) {
          this.seen.speed = true;
          console.log("[DISCOVER] Speed path:", name, "=", rawValue);
        }
      }

      // ---- Fader fallback if device publishes it on deck ----
      if ((/ExternalMixerVolume$/i.test(tail) || /MixerVolume$/i.test(tail)) && typeof rawValue === "number") {
        ds.fader = clamp01(rawValue);
        this.touch(deck);
        if (!this.seen.fader) {
          this.seen.fader = true;
          console.log("[DISCOVER] Fader (deck) path:", name, "=", rawValue);
        }
      }

      // ---- Elapsed seconds (some builds publish it in state map) ----
      // Names vary: Timeline, Elapsed, TrackElapsed, etc.
      if ((/Timeline$/i.test(tail) || /Elapsed/i.test(tail)) && typeof rawValue === "number") {
        ds.elapsedSec = Math.max(0, rawValue);
        this.touch(deck);
        if (!this.seen.elapsed) {
          this.seen.elapsed = true;
          console.log("[DISCOVER] ElapsedSec path:", name, "=", rawValue);
        }
      }

      // ---- Track title / artist (keep your exact matches, plus fallback patterns) ----
      if ((/SongName$/i.test(tail) || /Title$/i.test(tail)) && typeof rawValue === "string" && rawValue.trim()) {
        ds.title = rawValue;
        this.touch(deck);
      }
      if ((/ArtistName$/i.test(tail) || /Artist$/i.test(tail)) && typeof rawValue === "string" && rawValue.trim()) {
        ds.artist = rawValue;
        this.touch(deck);
      }

      // ---- Play state (edge-detected) ----
      const isPlayish =
        /(^|\/)(Play|Playing|PlayState|IsPlaying)$/.test(tail) || tail.includes("Play");

      if (isPlayish) {
        const playing = this.coerceBool(rawValue);
        const playing2 =
          typeof playing === "boolean"
            ? playing
            : (typeof rawValue === "number" ? rawValue > 0 : undefined);

        if (typeof playing2 === "boolean") {
          ds.play = playing2;
          this.touch(deck);
          this.maybeLogPlayChange(deck, playing2);
        }
      }

    });



    // nowPlaying provides high-level track + some realtime values.
    devices.on?.("nowPlaying", (status: any) => {
      // Some payloads use 1..4 in status.player, others include deck strings like '1A'.
      const deckNum = Number(status?.player);
      const deck = deckNum as DeckNumber;

      if (!DECKS.includes(deck)) return;

      const ds = this.decks[deck];
      ds.title = status?.title || ds.title || "—";
      ds.artist = status?.artist || ds.artist || "—";

      // Some builds include key info in nowPlaying
      if (typeof status?.currentKeyIndex === "number") ds.keyIndex = status.currentKeyIndex;
      if (typeof status?.keyIndex === "number") ds.keyIndex = status.keyIndex;


      if (typeof status?.currentBpm === "number") ds.currentBpm = status.currentBpm;
      if (typeof status?.externalMixerVolume === "number") {
        ds.fader = clamp01(status.externalMixerVolume);
      }
      if (typeof status?.play === "boolean") ds.play = status.play;

      this.recomputeDerived(deck);
      this.touch(deck);
    });

    /**
     * BeatInfo
     * Depending on your @gree44/stagelinq build, beatMessage can be either:
     *  A) flattened per-deck: { deck: 0..3, bpm, timeline, samples, ... }
     *  B) aggregated: { decks: [{ bpm, samples, ... }, ...] }
     *
     * Support both.
     */
    devices.on?.("beatMessage", (a: any, b?: any) => {
      // Some emitters provide (info, payload), others (payload) only.
      const payload = b ?? a;

      // A) flattened payload: has deck index
      if (payload && (typeof payload.deck === "number" || typeof payload.deck === "string")) {
        const deck = (Number(payload.deck) + 1) as DeckNumber; // 0..3 -> 1..4
        if (!DECKS.includes(deck)) return;

        const ds = this.decks[deck];
        if (typeof payload.samples === "number") {
          const sr = this.sampleRateHz[deck];
          if (typeof sr === "number" && sr > 0) {
            ds.elapsedSec = Math.max(0, payload.samples / sr);
            if (!this.seen.elapsed) {
              this.seen.elapsed = true;
              console.log("[DISCOVER] ElapsedSec from BeatInfo samples:", deck, "samples=", payload.samples, "sr=", sr);
            }
          }
        }



        if (typeof payload.bpm === "number") ds.currentBpm = payload.bpm;

        this.recomputeDerived(deck);
        this.touch(deck);
        return;
      }

      // B) aggregated payload: { decks: [...] }
      const decksArr: any[] | undefined = payload?.decks;
      if (Array.isArray(decksArr)) {
        decksArr.forEach((d, idx) => {
          const deck = (idx + 1) as DeckNumber;
          if (!DECKS.includes(deck)) return;

          const ds = this.decks[deck];
          if (typeof d?.bpm === "number") ds.currentBpm = d.bpm;

          // Prefer samples + sampleRate (ArtNet-style) if available
          if (typeof d?.samples === "number") {
            const sr = this.sampleRateHz[deck];
            if (typeof sr === "number" && sr > 0) {
              ds.elapsedSec = Math.max(0, d.samples / sr);
              if (!this.seen.elapsed) {
                this.seen.elapsed = true;
                console.log("[DISCOVER] ElapsedSec from BeatInfo decks[].samples:", deck, "samples=", d.samples, "sr=", sr);
              }
            }
          } else if (typeof d?.timeline === "number") {
            // fallback if your BeatInfo also provides timeline seconds
            ds.elapsedSec = Math.max(0, d.timeline);
          }



          this.recomputeDerived(deck);
          this.touch(deck);
        });
      }
    });

    // State map updates include TrackLength, Speed, CurrentKeyIndex, ExternalMixerVolume, etc.
    devices.on?.("stateChanged", (state: any) => {
      const name = String(state?.name || "");
      const m = name.match(/^\/Engine\/Deck([1-4])\/(.*)$/);
      if (!m) return;

      const deck = Number(m[1]) as DeckNumber;
      if (!DECKS.includes(deck)) return;

      const tail = m[2];
      const value = state?.value;
      const ds = this.decks[deck];

      if (tail === "TrackLength" || tail === "Track/TrackLength") {
        if (typeof value === "number") ds.totalSec = Math.max(0, value);
      } else if (tail === "CurrentBPM" || tail === "Track/CurrentBPM") {
        if (typeof value === "number") ds.currentBpm = value;
      } else if (tail === "Speed" || tail === "Track/Speed") {
        if (typeof value === "number") ds.speed = value;
      } else if (tail === "ExternalMixerVolume" || tail === "Track/ExternalMixerVolume") {
        if (typeof value === "number") ds.fader = clamp01(value);
      } else if (tail === "ArtistName" || tail === "Track/ArtistName") {
        if (typeof value === "string" && value.trim()) ds.artist = value;
      } else if (tail === "SongName" || tail === "Track/SongName") {
        if (typeof value === "string" && value.trim()) ds.title = value;
      } else if (tail === "CurrentKeyIndex" || tail === "Track/CurrentKeyIndex") {
        if (typeof value === "number") ds.keyIndex = value;
      } else if (tail === "Play" || tail === "PlayState") {
        // Some builds may surface play state here too
        const playing = this.coerceBool(value);
        if (typeof playing === "boolean") {
          ds.play = playing;
          this.maybeLogPlayChange(deck, playing);
        }
      }

      this.recomputeDerived(deck);
      this.touch(deck);
    });
  }

  async connect() {
    // stagelinq package exposes static connect().
    await StageLinq.connect();
  }

  async disconnect() {
    await StageLinq.disconnect();
  }

  getDecks(): Record<DeckNumber, DeckState> {
    const out = {} as Record<DeckNumber, DeckState>;
    for (const d of DECKS) out[d] = { ...this.decks[d] };
    return out;
  }
}
