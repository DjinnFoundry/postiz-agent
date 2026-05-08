import { config } from '../config.js';
import type { StoryAssets } from '../types.js';

export function brandFor(assets: StoryAssets): string {
  return assets.metadata.meta.brand ?? config.content.brand;
}

export function tagsFor(assets: StoryAssets, extras: string[] = []): string[] {
  const tags = assets.metadata.meta.tags;
  const sourceTags = Array.isArray(tags) ? tags.filter(isString) : [];
  return unique([...sourceTags, assets.metadata.mood, ...extras]);
}

export function hashtagsFor(assets: StoryAssets, extras: string[] = []): string {
  return tagsFor(assets, extras)
    .map(tag => tag.replace(/^#/, '').trim())
    .filter(Boolean)
    .map(tag => `#${tag.replace(/[^\p{L}\p{N}_-]+/gu, '')}`)
    .filter(tag => tag.length > 1)
    .join(' ');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
