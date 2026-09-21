import { describe, expect, it } from 'vitest';
import { parseRow, pickActive, rowToTrack, spotifyIdFrom, type MacRow } from './macos.js';

const row = (fields: Partial<Record<number, string>>, base: string[]): string => {
  const out = [...base];
  for (const [i, v] of Object.entries(fields)) out[Number(i)] = v!;
  return out.join('\t');
};

const SPOTIFY = [
  'Spotify', 'playing', '41.5', 'spotify:track:5H4mXWKcicuLKDn4Jy0sK7', '192931',
  'Drake', 'Time Flies', 'Dark Lane Demo Tapes', 'https://i.scdn.co/image/abc',
];
const MUSIC = [
  'Music', 'paused', '12.25', 'A1B2C3D4E5F6', '214.6',
  'Nina Simone', 'Sinnerman', 'Pastel Blues', '',
];

describe('parseRow', () => {
  it('reads a Spotify row, whose duration is already milliseconds', () => {
    const r = parseRow(SPOTIFY.join('\t'))!;
    expect(r.player).toBe('Spotify');
    expect(r.status).toBe('playing');
    expect(r.positionMs).toBeCloseTo(41_500);
    expect(r.durationMs).toBe(192_931);
    expect(r.title).toBe('Time Flies');
    expect(r.artUrl).toBe('https://i.scdn.co/image/abc');
  });

  it('converts Music.app seconds to milliseconds', () => {
    const r = parseRow(MUSIC.join('\t'))!;
    expect(r.player).toBe('Music');
    expect(r.status).toBe('paused');
    expect(r.positionMs).toBeCloseTo(12_250);
    expect(r.durationMs).toBeCloseTo(214_600);
  });

  it('accepts comma decimal separators from a localised AppleScript', () => {
    const r = parseRow(row({ 2: '41,5' }, SPOTIFY))!;
    expect(r.positionMs).toBeCloseTo(41_500);
  });

  it('rejects short rows and unknown players', () => {
    expect(parseRow('Spotify\tplaying\t1')).toBeNull();
    expect(parseRow(row({ 0: 'VLC' }, SPOTIFY))).toBeNull();
    expect(parseRow('')).toBeNull();
  });
});

describe('spotifyIdFrom', () => {
  it('pulls the id out of a track uri', () => {
    expect(spotifyIdFrom('spotify:track:5H4mXWKcicuLKDn4Jy0sK7')).toBe('5H4mXWKcicuLKDn4Jy0sK7');
  });

  it('has none for a Music.app persistent id', () => {
    expect(spotifyIdFrom('A1B2C3D4E5F6')).toBeUndefined();
  });
});

describe('rowToTrack', () => {
  it('keys a Spotify track by its id, so the cache matches the Linux side', () => {
    const track = rowToTrack(parseRow(SPOTIFY.join('\t'))!)!;
    expect(track.trackKey).toBe('spotify:5H4mXWKcicuLKDn4Jy0sK7');
    expect(track.source).toBe('spotify');
  });

  it('falls back to a metadata key for Music.app', () => {
    const track = rowToTrack(parseRow(MUSIC.join('\t'))!)!;
    expect(track.trackKey).toBe('meta:nina simone|sinnerman|215');
    expect(track.source).toBe('appleMusic');
    expect(track.artUrl).toBeUndefined();
  });

  it('is nothing at all when there is no title and no artist', () => {
    const blank = parseRow(row({ 5: '', 6: '' }, SPOTIFY))!;
    expect(rowToTrack(blank)).toBeNull();
  });
});

describe('pickActive', () => {
  const asRow = (line: string): MacRow => parseRow(line)!;

  it('prefers whatever is actually playing over app order', () => {
    const paused = asRow(row({ 1: 'paused' }, SPOTIFY));
    const playing = asRow(row({ 1: 'playing' }, MUSIC));
    expect(pickActive([paused, playing])?.player).toBe('Music');
  });

  it('breaks a tie towards Spotify, which carries a track id', () => {
    const a = asRow(row({ 1: 'paused' }, SPOTIFY));
    const b = asRow(row({ 1: 'paused' }, MUSIC));
    expect(pickActive([b, a])?.player).toBe('Spotify');
  });

  it('is null for an empty room', () => {
    expect(pickActive([])).toBeNull();
  });
});
