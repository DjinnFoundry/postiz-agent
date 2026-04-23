import { describe, expect, it } from 'vitest';
import { moderateWords } from '../../src/media/caption-moderation.js';

const fixture = [
  { text: 'Marcos', start: 0, end: 0.4 },
  { text: 'camina', start: 0.4, end: 0.8 },
  { text: 'por', start: 0.8, end: 1.0 },
  { text: 'el', start: 1.0, end: 1.2 },
  { text: 'bosque', start: 1.2, end: 1.6 },
  { text: 'mierda,', start: 1.6, end: 1.9 }, // blocked
  { text: 'dijo', start: 1.9, end: 2.2 },
  { text: 'Coño.', start: 2.2, end: 2.5 }, // blocked, accented, with trailing period
];

describe('moderateWords()', () => {
  it('replaces blocked tokens with *** by default', () => {
    const out = moderateWords(fixture);
    expect(out.replacements).toBe(2);
    expect(out.words[5]!.text).toBe('******,'); // mierda(6 letters) + trailing comma
    expect(out.words[7]!.text).toBe('****.');   // coño(4 letters) + period
    // other tokens untouched
    expect(out.words[0]!.text).toBe('Marcos');
    expect(out.words[4]!.text).toBe('bosque');
    // timing preserved
    expect(out.words[5]!.start).toBe(1.6);
    expect(out.words[5]!.end).toBe(1.9);
  });

  it('drops blocked tokens when mode=drop', () => {
    const out = moderateWords(fixture, { mode: 'drop' });
    expect(out.replacements).toBe(2);
    expect(out.words).toHaveLength(fixture.length - 2);
    for (const w of out.words) {
      expect(w.text).not.toMatch(/mierda|coño/i);
    }
  });

  it('is a no-op when no tokens match', () => {
    const clean = [
      { text: 'hola', start: 0, end: 0.5 },
      { text: 'mundo', start: 0.5, end: 1 },
    ];
    const out = moderateWords(clean);
    expect(out.replacements).toBe(0);
    expect(out.words).toEqual(clean);
  });

  it('honours the extraBlocklist option', () => {
    const input = [
      { text: 'dragon', start: 0, end: 0.5 },
      { text: 'fuego', start: 0.5, end: 1 },
    ];
    const out = moderateWords(input, { extraBlocklist: ['fuego'] });
    expect(out.replacements).toBe(1);
    expect(out.words[0]!.text).toBe('dragon');
    expect(out.words[1]!.text).toBe('*****');
  });

  it('ignores accents and case when matching', () => {
    const input = [
      { text: 'CABRÓN', start: 0, end: 0.5 },
      { text: 'cabron', start: 0.5, end: 1 },
      { text: 'Cabron,', start: 1, end: 1.5 },
    ];
    const out = moderateWords(input);
    expect(out.replacements).toBe(3);
    for (const w of out.words) {
      expect(w.text.startsWith('*')).toBe(true);
    }
  });

  it('returns a fresh array and does not mutate the input', () => {
    const input = [{ text: 'mierda', start: 0, end: 0.5 }];
    const snapshot = structuredClone(input);
    const out = moderateWords(input);
    expect(input).toEqual(snapshot);
    expect(out.words).not.toBe(input);
  });
});

describe('blocklist expansion', () => {
  function wordsOf(tokens: string[]) {
    return tokens.map((text, i) => ({ text, start: i * 0.5, end: (i + 1) * 0.5 }));
  }

  function expectAllBlocked(tokens: string[]) {
    const out = moderateWords(wordsOf(tokens));
    expect(out.replacements).toBe(tokens.length);
    for (const w of out.words) {
      expect(w.text.startsWith('*')).toBe(true);
    }
  }

  function expectNoneBlocked(tokens: string[]) {
    const out = moderateWords(wordsOf(tokens));
    expect(out.replacements).toBe(0);
    for (let i = 0; i < tokens.length; i++) {
      expect(out.words[i]!.text).toBe(tokens[i]);
    }
  }

  it('catches gerund forms of joder (jodiendo)', () => {
    expectAllBlocked(['jodiendo', 'Jodiendo', 'jodiendo,']);
  });

  it('catches participle forms: jodido/jodida/jodidos/jodidas', () => {
    expectAllBlocked(['jodido', 'jodida', 'jodidos', 'jodidas']);
  });

  it('catches present-tense conjugations of joder', () => {
    expectAllBlocked(['jodo', 'jodes', 'jode', 'joden']);
  });

  it('catches compound insults built on hijo + puta', () => {
    expectAllBlocked(['hijoputa', 'hijoputas', 'hijueputa', 'hijueputas', 'hdp']);
  });

  it('catches gilipollas variants (gilipollez, gilipolleces)', () => {
    expectAllBlocked(['gilipollas', 'gilipollez', 'gilipolleces', 'gilipollada', 'gilipolladas']);
  });

  it('catches cabron family including dialectal cabrón', () => {
    expectAllBlocked(['cabron', 'cabrón', 'cabrones', 'cabrona', 'cabronas', 'cabronazo']);
  });

  it('catches plurals and derivations of coño and mierda', () => {
    expectAllBlocked(['coños', 'conos', 'mierdas', 'mierdita', 'mierdoso']);
  });

  it('catches LatAm dialect: chingar family', () => {
    expectAllBlocked(['chingar', 'chinga', 'chingada', 'chingadera', 'chingado', 'chingón', 'chingona']);
  });

  it('catches puto/puta plurals and diminutives', () => {
    expectAllBlocked(['puta', 'putas', 'puto', 'putos', 'putita', 'putilla', 'putero']);
  });

  it('catches puñetero/puñetera', () => {
    expectAllBlocked(['puñetero', 'puñetera', 'puñeteros', 'puneteras']);
  });

  it('catches cojones and cojonudo', () => {
    expectAllBlocked(['cojones', 'cojonudo', 'cojonuda', 'cojonazo']);
  });

  it('catches pendejo family', () => {
    expectAllBlocked(['pendejo', 'pendeja', 'pendejos', 'pendejas', 'pendejada']);
  });

  it('catches maricón family', () => {
    expectAllBlocked(['maricon', 'maricón', 'maricones', 'mariconazo']);
  });

  it('does NOT block zorra (legitimate fable animal for kids stories)', () => {
    expectNoneBlocked(['zorra', 'zorras', 'zorro', 'zorros']);
  });

  it('does NOT block concha (seashell / proper noun)', () => {
    expectNoneBlocked(['concha', 'conchas']);
  });

  it('does NOT block pene/penes (biological/educational context)', () => {
    expectNoneBlocked(['pene', 'penes']);
  });

  it('catches hostia variants', () => {
    expectAllBlocked(['hostia', 'hostias', 'hostión', 'hostiazo']);
  });

  it('catches coger', () => {
    expectAllBlocked(['coger']);
  });

  it('does NOT trigger on diputado (substring "puto")', () => {
    expectNoneBlocked(['diputado', 'diputados', 'diputada', 'diputadas']);
  });

  it('does NOT trigger on computador/computadora (substring "puta")', () => {
    expectNoneBlocked(['computador', 'computadora', 'computadores']);
  });

  it('does NOT trigger on jogger/joggers/jogging', () => {
    expectNoneBlocked(['jogger', 'joggers', 'jogging']);
  });

  it('does NOT trigger on dragon-marcos fixture relevant words', () => {
    expectNoneBlocked([
      'Marcos', 'bosque', 'dragón', 'dragones', 'escupir', 'llamarada',
      'dorada', 'castillo', 'amigo', 'amigos', 'creer', 'nubes', 'mamá',
    ]);
  });

  it('does NOT trigger on common harmless words that share stems', () => {
    expectNoneBlocked([
      'pollito',
      'pollitos',
      'cogollo',
      'escoger',
      'recoger',
      'acoger',
      'polea',
      'poleas',
    ]);
  });

  it('does NOT trigger on words containing "cono" root (cónico, cónica)', () => {
    expectNoneBlocked(['cónico', 'cónica', 'conocer', 'conocido']);
  });
});
