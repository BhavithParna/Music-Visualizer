import { describe, it, expect } from 'vitest';
import { simplifyTitle, simplifyAlbum, primaryArtist, queryVariants } from './title.js';

describe('simplifyTitle', () => {
  it('strips featured-artist suffixes', () => {
    expect(simplifyTitle('Ran To Atlanta (feat. Future & Molly Santana)')).toBe('Ran To Atlanta');
    expect(simplifyTitle('Song [ft. Someone]')).toBe('Song');
    expect(simplifyTitle('Song - feat. Someone')).toBe('Song');
  });

  it('strips remaster and edition markers', () => {
    expect(simplifyTitle('Creep - 2008 Remaster')).toBe('Creep');
    expect(simplifyTitle('Track (Deluxe Version)')).toBe('Track');
    expect(simplifyTitle('Track - Radio Edit')).toBe('Track');
  });

  it('leaves a clean title alone', () => {
    expect(simplifyTitle('MY EYES')).toBe('MY EYES');
    expect(simplifyTitle('Toosie Slide')).toBe('Toosie Slide');
  });

  it('does not eat parentheses that are part of the title', () => {
    expect(simplifyTitle('Blinded (By The Light)')).toBe('Blinded (By The Light)');
  });
});

describe('primaryArtist', () => {
  it('keeps only the lead artist', () => {
    expect(primaryArtist('Drake, Future')).toBe('Drake');
    expect(primaryArtist('Drake & Future')).toBe('Drake');
    expect(primaryArtist('Drake feat. Future')).toBe('Drake');
  });

  it('does not split a name that merely contains an ampersand word', () => {
    expect(primaryArtist('Simon & Garfunkel')).toBe('Simon');
  });
});

describe('simplifyAlbum', () => {
  it('drops edition suffixes', () => {
    expect(simplifyAlbum('UTOPIA (Deluxe Edition)')).toBe('UTOPIA');
    expect(simplifyAlbum('Midnights')).toBe('Midnights');
  });
  it('returns undefined for nothing', () => {
    expect(simplifyAlbum(undefined)).toBeUndefined();
  });
});

describe('queryVariants', () => {
  it('tries the exact title first, then simplifications', () => {
    const v = queryVariants('Ran To Atlanta (feat. Future)', 'Drake', 'ICEMAN');
    expect(v[0]).toEqual({ title: 'Ran To Atlanta (feat. Future)', artist: 'Drake', album: 'ICEMAN' });
    expect(v.some((x) => x.title === 'Ran To Atlanta')).toBe(true);
  });

  it('collapses to a single attempt when nothing can be simplified', () => {
    expect(queryVariants('MY EYES', 'Travis Scott')).toHaveLength(1);
  });

  it('never emits an entry with an empty title or artist', () => {
    for (const v of queryVariants('Song (feat. X)', 'A & B', 'Album (Deluxe)')) {
      expect(v.title.length).toBeGreaterThan(0);
      expect(v.artist.length).toBeGreaterThan(0);
    }
  });
});
