/**
 * Title/artist normalisation for provider lookups.
 *
 * Player metadata carries decorations that lyric databases do not index:
 * featured artists, remaster tags, edit markers. Matching on the raw title
 * silently costs word-level sync on a large share of rap and pop, so every
 * provider retries with a simplified form.
 */
export function simplifyTitle(title: string): string {
  return title
    .replace(/\s*[-–]\s*(?:\d{4}\s*)?(?:remaster(?:ed)?|remix|radio edit|live|mono|stereo|version|edit)\b.*$/i, '')
    .replace(/\s*[([]\s*(?:feat|ft|with|prod)\.?[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([][^)\]]*(?:remaster|deluxe|bonus|version|edit|live|mix)[^)\]]*[)\]]/gi, '')
    .replace(/\s*[-–]\s*(?:feat|ft)\.?\s.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Album names carry the same decorations, plus edition suffixes. */
export function simplifyAlbum(album: string | undefined): string | undefined {
  if (!album) return undefined;
  const out = album
    .replace(/\s*[([][^)\]]*(?:deluxe|expanded|edition|anniversary|remaster|version|bonus)[^)\]]*[)\]]/gi, '')
    .replace(/\s*[-–]\s*(?:deluxe|expanded).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out || undefined;
}

/** MPRIS joins multiple artists; databases usually index only the first. */
export function primaryArtist(artist: string): string {
  return artist.split(/\s*(?:,|;|\s&\s|\sfeat\.?\s|\sft\.?\s|\swith\s)\s*/i)[0]?.trim() ?? artist;
}

/**
 * Query variants to try, most specific first, with duplicates removed.
 * Stopping at the first hit keeps the common case to a single request.
 */
export function queryVariants(
  title: string,
  artist: string,
  album?: string,
): { title: string; artist: string; album?: string }[] {
  const st = simplifyTitle(title);
  const sa = primaryArtist(artist);
  const sal = simplifyAlbum(album);

  const candidates = [
    { title, artist, album },
    { title: st, artist, album: sal },
    { title: st, artist: sa, album: sal },
    { title: st, artist: sa },
  ];

  const seen = new Set<string>();
  const out: { title: string; artist: string; album?: string }[] = [];
  for (const c of candidates) {
    if (!c.title || !c.artist) continue;
    const key = `${c.title}\u0000${c.artist}\u0000${c.album ?? ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: { title: string; artist: string; album?: string } = { title: c.title, artist: c.artist };
    if (c.album) entry.album = c.album;
    out.push(entry);
  }
  return out;
}
