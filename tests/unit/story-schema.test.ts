import { describe, expect, it } from 'vitest';
import { StorySchema } from '../../src/types.js';

describe('StorySchema', () => {
  it('accepts the generic MP3-first content contract', () => {
    const story = StorySchema.parse({
      title: 'Launch recap',
      content: 'First segment. Second segment.',
      mood: 'launch',
      meta: {
        slug: 'launch-recap',
        brand: 'Acme Media',
      },
    });

    expect(story.title).toBe('Launch recap');
    expect(story.content).toBe('First segment. Second segment.');
    expect(story.meta.brand).toBe('Acme Media');
    expect(story.meta.wordCount).toBe(4);
    expect(story.meta.estimatedDurationMin).toBe(1);
  });

  it('keeps backward compatibility with legacy Spanish field aliases', () => {
    const story = StorySchema.parse({
      titulo: 'El dragón curioso',
      contenido: 'Marcos caminaba por el bosque.',
      vocabularioNuevo: ['dragón'],
      mood: 'fantasia',
      meta: {
        slug: 'dragon-marcos',
        name: 'Marcos',
        age: 6,
      },
    });

    expect(story.title).toBe('El dragón curioso');
    expect(story.content).toBe('Marcos caminaba por el bosque.');
    expect(story.vocabulary).toEqual(['dragón']);
    expect(story.meta.audienceName).toBe('Marcos');
    expect(story.meta.audienceAge).toBe(6);
  });
});
