import { AudioKidsAdapter } from './audiokids.js';
import type { ContentBundle } from '../core/content-bundle.js';

/**
 * A BundleAdapter is the seam between a content-producing pipeline (AudioKids,
 * a podcast trimmer, a meme generator, a developer-content scraper, etc.) and
 * the publication toolkit. Each adapter knows how to walk its own source of
 * truth (a directory, an API, a database) and turn one entry into a
 * neutral ContentBundle. Tools, themes, captions, and publishers from there on
 * are pipeline-agnostic.
 *
 * To plug in a new producer, implement this interface and `register` it onto
 * the AdapterRegistry. From the CLI an external agent picks the adapter with
 * `--adapter <name>` (or supplies a bundle inline with `--bundle-file`).
 */
export interface BundleAdapter {
  readonly name: string;
  readonly description: string;
  loadBundle(id: string): ContentBundle;
  listCandidates(): BundleCandidate[];
}

export interface BundleCandidate {
  id: string;
  generatedAtMs: number;
}

export interface AdapterDescriptor {
  name: string;
  description: string;
  candidateCount: number;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, BundleAdapter>();

  register(adapter: BundleAdapter): this {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`adapter "${adapter.name}" is already registered`);
    }
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  get(name: string): BundleAdapter {
    const a = this.adapters.get(name);
    if (!a) throw new Error(`unknown adapter "${name}". Known: ${this.names().join(', ') || '(none)'}`);
    return a;
  }

  names(): string[] {
    return [...this.adapters.keys()].sort();
  }

  list(): AdapterDescriptor[] {
    return this.names().map(name => {
      const a = this.adapters.get(name)!;
      let count = 0;
      try {
        count = a.listCandidates().length;
      } catch {
        count = 0;
      }
      return { name: a.name, description: a.description, candidateCount: count };
    });
  }
}

export interface CreateRegistryOptions {
  /** Override the AudioKids output directory the default registry's audiokids adapter reads. */
  audiokidsDir?: string;
}

/**
 * Default registry: contains every adapter the toolkit ships out of the box.
 * Today only AudioKids; new adapters get added here as they land. Pass
 * `audiokidsDir` to override the directory the audiokids adapter reads from
 * (used for multi-tenant setups where each tenant has its own AudioKids output).
 */
export function createDefaultRegistry(opts: CreateRegistryOptions = {}): AdapterRegistry {
  return new AdapterRegistry().register(new AudioKidsBundleAdapter(opts.audiokidsDir));
}

/**
 * Thin BundleAdapter wrapper around AudioKidsAdapter. Keeps the adapter class
 * focused on AudioKids parsing details and isolates the registry contract here.
 */
class AudioKidsBundleAdapter implements BundleAdapter {
  readonly name = 'audiokids';
  readonly description = 'Reads AudioKids stories from AUDIOKIDS_OUTPUT_DIR. Supports both layouts: v1 flat (<slug>.json + <slug>.mp3) and v2 subdir (<slug>/story.json + <slug>/<slug>.mp3). Produces audio-story bundles.';
  private readonly inner: AudioKidsAdapter;

  constructor(outputDir?: string) {
    this.inner = outputDir ? new AudioKidsAdapter(outputDir) : new AudioKidsAdapter();
  }

  loadBundle(id: string): ContentBundle {
    return this.inner.loadBundle(id);
  }

  listCandidates(): BundleCandidate[] {
    return this.inner.listCandidates().map(c => ({ id: c.slug, generatedAtMs: c.mtimeMs }));
  }
}
