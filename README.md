# DJ Decks Visualizer (Prime 4+ / StageLinq)

New project that:
- Connects to the Prime 4+ via StageLinq (standalone Engine DJ)
- Broadcasts a deck's timeline as Art-Net Timecode (optional)
- Serves a React web UI that shows **4 decks in 4 quadrants**
- Streams live deck state over WebSocket at **30 Hz**

## What you get in the UI
Per deck:
- Artwork placeholder
- Title + artist
- **Elapsed / total** time + remaining
- **Key** (Camelot-style string)
- **Current BPM**, derived **track BPM**, and **relative pitch %** (signed)
- Channel fader (ExternalMixerVolume) on the outside edge:
  - Deck 1 & 3: right
  - Deck 2 & 4: left
- Waveform placeholder bar at the bottom

Deck color accents:
- Deck 1: Purple/Magenta
- Deck 2: Blue
- Deck 3: Green
- Deck 4: Red

## Prereqs
- Node.js **22+**
- Prime 4+ and this PC on the same LAN

## Install
From the repo root:

```bash
npm install
```

## Development
Run the backend (StageLinq + WebSocket + static serving). In dev you can also run the frontend separately if you want, but it's optional.

```bash
npm run -w backend dev
```

Open:
- `http://<this-pc-ip>:8090/` //192.168.0.79

### Optional: run frontend dev server
In another terminal:

```bash
npm run -w frontend dev
```

Then open the Vite URL it prints. (It proxies `/ws` and `/api` to the backend on `8090`.)

## Production build

```bash
npm run build
npm start
```

## Environment variables
Backend supports:

- `PORT` (default `8090`)

### Art-Net timecode (optional)
- `ARTNET_ENABLED` (default `true`; set to `false` to disable)
- `ARTNET_TARGET_IP` (default `255.255.255.255`)
- `ARTNET_PORT` (default `6454`)
- `ARTNET_DECK` (default `1`)

### Camelot key mapping override (optional)
StageLinq exposes `CurrentKeyIndex` as a number, but the exact index-to-key mapping is not consistently documented.

Default mapping in this project assumes:
- `0..23` -> `1A, 1B, 2A, 2B, ... 12A, 12B`

If your device uses a different mapping, override with:

- `KEY_MAP` = **24 comma-separated values**

Example:

```bash
KEY_MAP="1A,1B,2A,2B,3A,3B,4A,4B,5A,5B,6A,6B,7A,7B,8A,8B,9A,9B,10A,10B,11A,11B,12A,12B"
```

## Notes
- Track BPM is derived from `CurrentBPM / Speed`.
- Relative % shown is `(Speed - 1) * 100`.
- Track length uses `/Engine/DeckX/TrackLength`.
- Timeline/elapsed uses BeatInfo `timeline`.
