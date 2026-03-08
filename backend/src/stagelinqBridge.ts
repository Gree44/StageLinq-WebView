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

  // Raw speed values as published by StageLinq.
  // On some devices /Engine/DeckX/Speed is *not* a direct ratio where 1.0 == neutral.
  // Instead, neutral is whatever /Engine/DeckX/SpeedNeutral reports.
  // We normalize to a real ratio: ratio = speedRaw / speedNeutralRaw.
  private speedRaw: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };
  private speedNeutralRaw: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };

  // TrackLength is sometimes published in *samples* (not seconds).
  // If we see a "too large" number, we keep it here until we have SampleRate.
  private pendingTrackLengthSamples: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };

  // Throttle elapsedSec updates (we don't need frame-accurate like timecode)
  private lastElapsedEmitSec: Record<DeckNumber, number> = { 1: -1, 2: -1, 3: -1, 4: -1 };

  constructor(_opts: BridgeOptions = {}) {
    this.decks = Object.fromEntries(
      DECKS.map((d) => [d, this.blankDeck(d)])
    ) as Record<DeckNumber, DeckState>;

    this.wire();
  }

  private blankDeck(deck: DeckNumber): DeckState {
    return {
      deck,
      trackLoaded: false,
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

  private unloadDeck(deck: DeckNumber) {
    const fader = this.decks[deck].fader;
    this.decks[deck] = this.blankDeck(deck);
    this.decks[deck].fader = fader; // preserve fader position
    this.sampleRateHz[deck] = null;
    this.speedRaw[deck] = null;
    this.speedNeutralRaw[deck] = null;
    this.pendingTrackLengthSamples[deck] = null;
    this.lastElapsedEmitSec[deck] = -1;
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

    // Normalize raw speed to a real ratio when possible.
    // If SpeedNeutral is present, use ratio = raw / neutral.
    // Otherwise assume ds.speed already is a ratio.
    const raw = this.speedRaw[deck];
    const neutral = this.speedNeutralRaw[deck];

    if (Number.isFinite(raw) && Number.isFinite(neutral) && (neutral as number) > 0) {
      ds.speed = (raw as number) / (neutral as number);
    }

    // trackBpm should come from /Engine/DeckX/Track/CurrentBPM when available.
    // Only use currentBpm/speed as a fallback if trackBpm is still unknown AND a track
    // is confirmed loaded. Without the trackLoaded guard, deck-unload events (which reset
    // trackBpm to 0) followed by beat messages would continuously recalculate trackBpm
    // from the live currentBpm, making both fields show the same changing value.
    if (ds.trackLoaded &&
      (!Number.isFinite(ds.trackBpm) || ds.trackBpm <= 0) &&
      Number.isFinite(ds.speed) &&
      ds.speed > 0.0001 &&
      Number.isFinite(ds.currentBpm) &&
      ds.currentBpm > 0) {
      ds.trackBpm = ds.currentBpm / ds.speed;
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

  private tryParseTrackData(deck: DeckNumber, raw: any) {
    // raw is usually msg.json or msg.json.string, depending on device/build
    let obj: any = raw;

    // Some builds wrap it as { string: "..." }
    if (obj && typeof obj === "object" && typeof obj.string === "string") obj = obj.string;

    // If it's a JSON string, parse it
    if (typeof obj === "string") {
      const s = obj.trim();
      try {
        obj = JSON.parse(s);
      } catch {
        return;
      }
    }

    if (!obj || typeof obj !== "object") return;

    const ds = this.decks[deck];

    // --- duration ---
    // try common shapes/units
    const durSec =
      (typeof obj.durationSec === "number" ? obj.durationSec : undefined) ??
      (typeof obj.duration === "number" ? obj.duration : undefined) ??
      (typeof obj.lengthSec === "number" ? obj.lengthSec : undefined) ??
      (typeof obj.trackLength === "number" ? obj.trackLength : undefined);

    const durMs =
      (typeof obj.durationMs === "number" ? obj.durationMs : undefined) ??
      (typeof obj.lengthMs === "number" ? obj.lengthMs : undefined);

    if (typeof durMs === "number" && durMs > 0) {
      ds.totalSec = durMs / 1000;
      this.touch(deck);
      if (!this.seen.total) {
        this.seen.total = true;
        console.log("[DISCOVER] totalSec from TrackData (ms):", deck, ds.totalSec);
      }
    } else if (typeof durSec === "number" && durSec > 0) {
      ds.totalSec = durSec;
      this.touch(deck);
      if (!this.seen.total) {
        this.seen.total = true;
        console.log("[DISCOVER] totalSec from TrackData (s):", deck, ds.totalSec);
      }
    }

    // --- key ---
    // numeric index
    const keyIdx =
      (typeof obj.currentKeyIndex === "number" ? obj.currentKeyIndex : undefined) ??
      (typeof obj.keyIndex === "number" ? obj.keyIndex : undefined);

    if (typeof keyIdx === "number") {
      ds.keyIndex = keyIdx;
      this.recomputeDerived(deck);
      this.touch(deck);
      if (!this.seen.key) {
        this.seen.key = true;
        console.log("[DISCOVER] keyIndex from TrackData:", deck, keyIdx, "->", ds.keyCamelot);
      }
      return;
    }

    // camelot string directly
    const camelot =
      (typeof obj.camelot === "string" ? obj.camelot : undefined) ??
      (typeof obj.key === "string" ? obj.key : undefined);

    if (typeof camelot === "string" && camelot.trim()) {
      ds.keyCamelot = camelot.trim();
      this.touch(deck);
      if (!this.seen.key) {
        this.seen.key = true;
        console.log("[DISCOVER] key (string) from TrackData:", deck, ds.keyCamelot);
      }
    }
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
      // Your probe shows paths like: /Mixer/CH2faderPosition
      const mixerMatch = String(name).match(/^\/Mixer\/CH([1-4])faderPosition$/);
      if (mixerMatch) {
        const ch = Number(mixerMatch[1]) as DeckNumber;

        if (typeof rawValue === "number") {
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

      // TrackData often contains duration + key info on Prime/Denon
      if (/(Track\/)?TrackData$/i.test(tail)) {
        this.tryParseTrackData(deck, json); // pass the whole json wrapper
        return;
      }


      // --- discovery: print first *usable* key/length messages we ever see ---
      if (!this.seen.key && /key/i.test(tail)) {
        console.log("[DISCOVER] KEY candidate:", name, "=", rawValue);
        // only lock once we actually got something usable
        if (typeof rawValue === "number" || (typeof rawValue === "string" && rawValue.trim())) {
          this.seen.key = true;
        }
      }

      if (!this.seen.total && /(tracklength|length|duration)/i.test(tail)) {
        console.log("[DISCOVER] LENGTH candidate:", name, "=", rawValue);
        if (typeof rawValue === "number") {
          this.seen.total = true;
        }
      }



      // ---- SampleRate (needed for BeatInfo samples -> seconds) ----
      if ((/Track\/SampleRate$/i.test(tail) || /SampleRate$/i.test(tail)) && typeof rawValue === "number") {
        if (Number.isFinite(rawValue) && rawValue > 0) {
          this.sampleRateHz[deck] = rawValue;

          // If TrackLength arrived earlier in samples, convert now.
          const pendingSamples = this.pendingTrackLengthSamples[deck];
          if (Number.isFinite(pendingSamples) && (pendingSamples as number) > 0) {
            ds.totalSec = (pendingSamples as number) / rawValue;
            this.pendingTrackLengthSamples[deck] = null;
            this.touch(deck);
            if (!this.seen.total) {
              this.seen.total = true;
              console.log(
                "[DISCOVER] TotalSec from TrackLength(samples)/SampleRate:",
                name,
                "samples=",
                pendingSamples,
                "sr=",
                rawValue,
                "->",
                ds.totalSec
              );
            }
          }

          if (!this.seen.elapsed) {
            console.log("[DISCOVER] SampleRate path:", name, "=", rawValue);
          }
        }
      }


      // ---- Total seconds ----
      if (/(Track\/)?(TrackLength|Duration|Length)(Ms)?$/i.test(tail) && typeof rawValue === "number") {
        const isMs = /Ms$/i.test(tail);
        // TrackLength sometimes comes in samples, not seconds.
        // Heuristic: anything > 100k is almost certainly samples (100k seconds is ~27h).
        const looksLikeSamples = !isMs && rawValue > 100000;

        if (looksLikeSamples) {
          const sr = this.sampleRateHz[deck];
          if (typeof sr === "number" && Number.isFinite(sr) && sr > 0) {
            ds.totalSec = Math.max(0, rawValue / sr);
          } else {
            // We'll convert once SampleRate arrives.
            this.pendingTrackLengthSamples[deck] = rawValue;
          }
        } else {
          ds.totalSec = Math.max(0, isMs ? rawValue / 1000 : rawValue);
        }
        this.touch(deck);

        if (!this.seen.total) {
          this.seen.total = true;
          console.log("[DISCOVER] TotalSec path:", name, "=", rawValue, isMs ? "(ms)" : "(s)");
        }
      }

      if (/(Track\/)?(CurrentKeyIndex|KeyIndex)$/i.test(tail) && typeof rawValue === "number") {
        ds.keyIndex = rawValue;
        this.recomputeDerived(deck);
        this.touch(deck);

        if (!this.seen.key) {
          this.seen.key = true;
          console.log("[DISCOVER] KeyIndex path:", name, "=", rawValue);
        }
      }

      // ---- Original / analyzed track BPM ----
      if (/(Track\/)?CurrentBPM$/i.test(tail) && /Track\//i.test(tail) && typeof rawValue === "number") {
        ds.trackBpm = rawValue;
        this.touch(deck);

        if (!Number.isFinite(ds.currentBpm) || ds.currentBpm <= 0) {
          ds.currentBpm = rawValue;
        }
      }

      // Sometimes key comes as a string (already Camelot like "8A")
      if (/(Track\/)?(Camelot|Key)$/i.test(tail) && typeof rawValue === "string" && rawValue.trim()) {
        ds.keyCamelot = rawValue.trim();
        this.touch(deck);

        if (!this.seen.key) {
          this.seen.key = true;
          console.log("[DISCOVER] Key (string) path:", name, "=", rawValue);
        }
      }



      // ---- Speed (pitch ratio) ----
      if ((/Speed$/i.test(tail) || /Track\/Speed$/i.test(tail)) && typeof rawValue === "number") {
        this.speedRaw[deck] = rawValue;
        // Default to raw until we also have SpeedNeutral.
        ds.speed = rawValue;
        this.recomputeDerived(deck);
        this.touch(deck);
        if (!this.seen.speed) {
          this.seen.speed = true;
          console.log("[DISCOVER] Speed path:", name, "=", rawValue);
        }
      }

      // ---- SpeedNeutral (used to normalize Speed -> ratio) ----
      if (/SpeedNeutral$/i.test(tail) && typeof rawValue === "number") {
        this.speedNeutralRaw[deck] = rawValue;
        this.recomputeDerived(deck);
        this.touch(deck);
        if (!this.seen.speed) {
          this.seen.speed = true;
          console.log("[DISCOVER] SpeedNeutral path:", name, "=", rawValue);
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

      // ---- Track title / artist (keep your exact matches, plus fallback patterns) ----
      if (/SongName$/i.test(tail) || /Title$/i.test(tail)) {
        if (typeof rawValue === "string") {
          if (rawValue.trim()) {
            ds.title = rawValue;
            ds.trackLoaded = true;
          } else {
            // Empty title signals track was ejected
            this.unloadDeck(deck);
          }
          this.touch(deck);
        }
      }
      if ((/ArtistName$/i.test(tail) || /Artist$/i.test(tail)) && typeof rawValue === "string" && rawValue.trim()) {
        ds.artist = rawValue;
        ds.trackLoaded = true;
        this.touch(deck);
      }

      // ---- Explicit track-loaded flag (some devices emit this) ----
      if (/TrackIsLoaded$/i.test(tail) || /IsLoaded$/i.test(tail)) {
        const loaded = this.coerceBool(rawValue);
        if (typeof loaded === "boolean") {
          if (!loaded) {
            this.unloadDeck(deck);
          } else {
            ds.trackLoaded = true;
          }
          this.touch(deck);
        }
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

      const playerIdx = Number(status?.player);
      const deck = (playerIdx + 1) as DeckNumber; // 0..3 -> 1..4
      if (!DECKS.includes(deck)) return;


      const ds = this.decks[deck];
      if (status?.title && String(status.title).trim()) {
        ds.title = status.title;
        ds.trackLoaded = true;
      } else {
        ds.title = ds.title || "—";
      }
      if (status?.artist && String(status.artist).trim()) {
        ds.artist = status.artist;
        ds.trackLoaded = true;
      } else {
        ds.artist = ds.artist || "—";
      }

      // Some builds include key info in nowPlaying
      if (typeof status?.currentKeyIndex === "number") ds.keyIndex = status.currentKeyIndex;
      if (typeof status?.keyIndex === "number") ds.keyIndex = status.keyIndex;


      if (typeof status?.currentBpm === "number") {
        ds.currentBpm = status.currentBpm;
      }
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
            const elapsed = payload.samples / sr;

            // Throttle: only update if elapsed changed by >= 0.1s
            if (Math.abs(elapsed - this.lastElapsedEmitSec[deck]) >= 0.1) {
              ds.elapsedSec = Math.max(0, elapsed);
              this.lastElapsedEmitSec[deck] = elapsed;

              if (!this.seen.elapsed) {
                this.seen.elapsed = true;
                console.log(
                  "[DISCOVER] ElapsedSec from BeatInfo samples:",
                  deck,
                  "samples=",
                  payload.samples,
                  "sr=",
                  sr
                );
              }
              this.touch(deck);
            }
          }
        }




        if (typeof payload.bpm === "number") {
          ds.currentBpm = payload.bpm;
        }

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
          if (typeof d?.bpm === "number") {
            ds.currentBpm = d.bpm;
          }

          // Prefer samples + sampleRate (ArtNet-style) if available
          if (typeof d?.samples === "number") {
            const sr = this.sampleRateHz[deck];
            if (typeof sr === "number" && sr > 0) {
              const elapsed = d.samples / sr;

              // Throttle: only update if elapsed changed by >= 0.1s
              if (Math.abs(elapsed - this.lastElapsedEmitSec[deck]) >= 0.1) {
                ds.elapsedSec = Math.max(0, elapsed);
                this.lastElapsedEmitSec[deck] = elapsed;

                if (!this.seen.elapsed) {
                  this.seen.elapsed = true;
                  console.log(
                    "[DISCOVER] ElapsedSec from BeatInfo decks[].samples:",
                    deck,
                    "samples=",
                    d.samples,
                    "sr=",
                    sr
                  );
                }
                this.touch(deck);
              }
            }
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
      } else if (tail === "CurrentBPM") {
        if (typeof value === "number") {
          ds.currentBpm = value;
        }
      } else if (tail === "Track/CurrentBPM") {
        if (typeof value === "number") {
          ds.trackBpm = value;
        }
      } else if (tail === "Speed" || tail === "Track/Speed") {
        if (typeof value === "number") ds.speed = value;
      } else if (tail === "ExternalMixerVolume" || tail === "Track/ExternalMixerVolume") {
        if (typeof value === "number") ds.fader = clamp01(value);
      } else if (tail === "ArtistName" || tail === "Track/ArtistName") {
        if (typeof value === "string") {
          if (value.trim()) { ds.artist = value; ds.trackLoaded = true; }
          else this.unloadDeck(deck);
        }
      } else if (tail === "SongName" || tail === "Track/SongName") {
        if (typeof value === "string") {
          if (value.trim()) { ds.title = value; ds.trackLoaded = true; }
          else this.unloadDeck(deck);
        }
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
