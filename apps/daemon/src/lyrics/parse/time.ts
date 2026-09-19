/**
 * TTML / LRC timestamp parsing.
 * Accepts clock time (`01:02:03.456`, `02:03.45`), plain seconds (`18.412`),
 * and offset time with a unit suffix (`18.412s`, `250ms`, `1.5m`).
 * Returns milliseconds, or null when the value is not a timestamp.
 */
export function parseTime(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const offset = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/i.exec(s);
  if (offset) {
    const v = Number(offset[1]);
    switch (offset[2]!.toLowerCase()) {
      case 'h': return v * 3600_000;
      case 'm': return v * 60_000;
      case 's': return v * 1000;
      case 'ms': return v;
      default: return v * 1000; // frames/ticks without a rate: treat as seconds
    }
  }

  const parts = s.split(':');
  if (parts.length === 1) {
    const v = Number(parts[0]);
    return Number.isFinite(v) ? v * 1000 : null;
  }
  if (parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    const v = Number(part.replace(',', '.'));
    if (!Number.isFinite(v)) return null;
    total = total * 60 + v;
  }
  return total * 1000;
}

export function formatTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
