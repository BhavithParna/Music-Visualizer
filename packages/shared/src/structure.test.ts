import { describe, expect, it } from 'vitest';
import type { LyricLine } from './types.js';
import { detectSections, sectionAt } from './structure.js';

let clock = 0;
function l(text: string, part?: string): LyricLine {
  const words = text.split(' ').map((t, i) => ({ text: t, startMs: clock + i * 300, endMs: clock + i * 300 + 280 }));
  const line: LyricLine = { text, startMs: clock, endMs: clock + words.length * 300, words };
  if (part) line.part = part;
  clock += words.length * 300 + 400;
  return line;
}

describe('detectSections', () => {
  it('finds choruses by repetition and a late bridge', () => {
    clock = 0;
    const chorus = () => [l('we run the night tonight'), l('nobody gets to leave')];
    const lines = [
      l('first verse line here'), l('second verse line now'),
      ...chorus(),
      l('another verse begins'), l('telling a different story'),
      ...chorus(),
      l('bridge material that is new'), l('only heard this once'),
      ...chorus(),
    ];
    const { sections, lineSection } = detectSections(lines);
    expect(sections.map((s) => s.kind)).toEqual(['verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus']);
    expect(sections.filter((s) => s.kind === 'chorus').map((s) => s.occurrence)).toEqual([0, 1, 2]);
    expect(lineSection[2]).toBe(1);
    expect(lineSection.length).toBe(lines.length);
    // Sections tile the timeline without gaps.
    for (let i = 1; i < sections.length; i += 1) expect(sections[i - 1]!.endMs).toBe(sections[i]!.startMs);
    expect(sectionAt(sections, sections[3]!.startMs + 10)).toBe(3);
    expect(sectionAt(sections, -5)).toBe(-1);
  });

  it('trusts TTML part labels when present', () => {
    clock = 0;
    const lines = [l('a b c', 'Verse'), l('d e f', 'Verse'), l('g h i', 'Chorus'), l('j k l', 'Bridge')];
    expect(detectSections(lines).sections.map((s) => s.kind)).toEqual(['verse', 'chorus', 'bridge']);
  });

  it('calls a song with no repeats one long verse', () => {
    clock = 0;
    const lines = [l('one two three'), l('four five six'), l('seven eight nine')];
    const { sections } = detectSections(lines);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe('verse');
    expect(sections[0]!.energy).toBe(1);
  });
});

describe('detectSections edge cases', () => {
  it('counts a repeated one-word hook but not repeated filler', () => {
    clock = 0;
    const lines = [
      l('the verse opens here'), l('yeah'), l('Paradise on fire'), l('Run'),
      l('second verse is new'), l('yeah'), l('Paradise on fire'), l('Run'),
    ];
    const kinds = detectSections(lines).sections.map((s) => s.kind);
    expect(kinds).toEqual(['verse', 'chorus', 'verse', 'chorus']);
  });
});

describe('detectSections part labels', () => {
  it('reads object part labels from older cached documents', () => {
    clock = 0;
    const lines = [l('a b c'), l('d e f'), l('g h i')];
    (lines[0] as unknown as { part: unknown }).part = { name: 'Intro', time: 0, duration: 10 };
    (lines[1] as unknown as { part: unknown }).part = { name: 'Chorus', time: 0, duration: 10 };
    (lines[2] as unknown as { part: unknown }).part = { name: 'Chorus', time: 0, duration: 10 };
    expect(detectSections(lines).sections.map((s) => s.kind)).toEqual(['intro', 'chorus']);
  });
});
