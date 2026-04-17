import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../config.js';
import { StorySchema, type Story, type StoryAssets } from '../types.js';

export class AudioKidsReader {
  constructor(private readonly outputDir: string = config.audiokids.outputDir) {}

  readStory(slug: string): StoryAssets {
    const jsonPath = join(this.outputDir, `${slug}.json`);
    const mp3Path = join(this.outputDir, `${slug}.mp3`);

    if (!existsSync(jsonPath)) {
      throw new Error(`Story metadata not found: ${jsonPath}`);
    }
    if (!existsSync(mp3Path)) {
      throw new Error(`Story audio not found: ${mp3Path}. Run the AudioKids pipeline first.`);
    }

    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const metadata = StorySchema.parse(raw);

    const coverPath = this.findCover(slug, metadata);

    return {
      slug,
      audioMp3Path: mp3Path,
      coverPngPath: coverPath,
      metadata,
    };
  }

  private findCover(slug: string, metadata: Story): string {
    const candidates = [
      join(this.outputDir, `${slug}-cover.png`),
      join(this.outputDir, `${slug}.png`),
      join(this.outputDir, 'covers', `${slug}.png`),
      join(config.paths.assetsDir, 'covers', `${metadata.mood}.png`),
      join(config.paths.assetsDir, 'cover-default.png'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    throw new Error(`No cover art found for ${slug}. Tried: ${candidates.join(', ')}`);
  }

  readNarrationText(slug: string): string {
    const txtPath = join(this.outputDir, `${slug}.txt`);
    if (!existsSync(txtPath)) {
      throw new Error(`Narration text not found: ${txtPath}`);
    }
    return readFileSync(txtPath, 'utf-8');
  }
}
