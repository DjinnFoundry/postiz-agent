import { describe, expect, it } from 'vitest';
import { flattenWords, type WhisperJson } from '../../src/media/whisper-json.js';

const baseJson = (overrides: Partial<WhisperJson> = {}): WhisperJson => ({
  text: '',
  language: 'es',
  segments: [],
  ...overrides,
});

describe('flattenWords', () => {
  it('returns an empty array when there are no segments', () => {
    expect(flattenWords(baseJson())).toEqual([]);
  });

  it('skips segments with missing words array', () => {
    const json = baseJson({
      segments: [
        { id: 0, start: 0, end: 1, text: 'Hola' }, // no words
      ],
    });
    expect(flattenWords(json)).toEqual([]);
  });

  it('skips segments whose words array is empty', () => {
    const json = baseJson({
      segments: [
        { id: 0, start: 0, end: 1, text: 'Hola', words: [] },
      ],
    });
    expect(flattenWords(json)).toEqual([]);
  });

  it('trims leading whitespace off each word', () => {
    const json = baseJson({
      segments: [
        {
          id: 0, start: 0, end: 1, text: ' Hola mundo',
          words: [
            { word: ' Hola', start: 0, end: 0.4 },
            { word: ' mundo', start: 0.4, end: 0.9 },
          ],
        },
      ],
    });
    expect(flattenWords(json)).toEqual([
      { word: 'Hola', start: 0, end: 0.4 },
      { word: 'mundo', start: 0.4, end: 0.9 },
    ]);
  });

  it('drops empty-text word entries', () => {
    const json = baseJson({
      segments: [
        {
          id: 0, start: 0, end: 1, text: 'Hola',
          words: [
            { word: ' ', start: 0, end: 0.1 },
            { word: 'Hola', start: 0.1, end: 0.5 },
            { word: '', start: 0.5, end: 0.5 },
          ],
        },
      ],
    });
    expect(flattenWords(json)).toEqual([
      { word: 'Hola', start: 0.1, end: 0.5 },
    ]);
  });

  it('flattens across multiple segments in order', () => {
    const json = baseJson({
      segments: [
        { id: 0, start: 0, end: 1, text: 'a', words: [{ word: 'a', start: 0, end: 0.5 }] },
        { id: 1, start: 1, end: 2, text: 'b', words: [{ word: 'b', start: 1, end: 1.5 }] },
      ],
    });
    expect(flattenWords(json).map(w => w.word)).toEqual(['a', 'b']);
  });

  it('preserves the per-word probability field when present', () => {
    const json = baseJson({
      segments: [
        {
          id: 0, start: 0, end: 1, text: 'Marcos',
          words: [
            { word: ' Marcos', start: 0, end: 0.4, probability: 0.64 },
            { word: ' corre', start: 0.4, end: 0.8, probability: 0.98 },
          ],
        },
      ],
    });
    const out = flattenWords(json);
    expect(out).toEqual([
      { word: 'Marcos', start: 0, end: 0.4, probability: 0.64 },
      { word: 'corre',  start: 0.4, end: 0.8, probability: 0.98 },
    ]);
  });

  it('leaves probability undefined when whisper did not emit it', () => {
    const json = baseJson({
      segments: [
        {
          id: 0, start: 0, end: 1, text: 'hola',
          words: [{ word: 'hola', start: 0, end: 0.5 }],
        },
      ],
    });
    expect(flattenWords(json)[0]!.probability).toBeUndefined();
  });
});
