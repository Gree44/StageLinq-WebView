/**
 * Best-effort mapping for Denon/Engine "CurrentKeyIndex" -> Camelot keycode.
 *
 * The StageLinq protocol exposes a numeric key index, but public docs do not
 * clearly standardize the index-to-key mapping.
 *
 * Default strategy here:
 *   index 0..23 maps to 1A,1B,2A,2B,...,12A,12B
 *
 * If your device uses a different mapping, you can override by setting
 * KEY_MAP env var to a comma-separated list of 24 entries.
 * Example:
 *   KEY_MAP="8A,8B,9A,9B,..."
 */

const DEFAULT_MAP: string[] = Array.from({ length: 24 }, (_, i) => {
  const num = Math.floor(i / 2) + 1; // 1..12
  const letter = i % 2 === 0 ? 'A' : 'B';
  return `${num}${letter}`;
});

function loadEnvMap(): string[] | null {
  const raw = process.env.KEY_MAP;
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 24) {
    console.warn(`KEY_MAP ignored: expected 24 comma-separated values, got ${parts.length}`);
    return null;
  }
  return parts;
}

const MAP = loadEnvMap() ?? DEFAULT_MAP;

export function keyIndexToCamelot(keyIndex: number | null | undefined): string {
  if (keyIndex == null || !Number.isFinite(keyIndex)) return '--';
  const idx = Math.trunc(keyIndex);
  if (idx < 0 || idx >= MAP.length) return '--';
  return MAP[idx] ?? '--';
}
