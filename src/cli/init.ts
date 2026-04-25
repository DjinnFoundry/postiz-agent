import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../config.js';

/**
 * `postiz-agent init` — onboarding wizard. An external agent (or a human)
 * runs this once per product (tenant). Output: tenants/<slug>/config.json
 * + data/<slug>/. Future-friendly: every prompt is a key the caller can
 * pre-supply via `answers` for non-interactive automation.
 */

const VALID_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PromptOptions {
  /** Stable key the caller can use to script answers. */
  key: string;
  /** Default surfaced to the user; pressing enter accepts it. */
  default?: string;
  /** Mark sensitive (e.g. API key); UIs may hide echo. */
  secret?: boolean;
}

export interface Prompter {
  ask(question: string, opts?: PromptOptions): Promise<string>;
}

export interface InitAnswers {
  slug?: string;
  brandName?: string;
  hashtags?: string;
  postizApiUrl?: string;
  postizApiKey?: string;
  audiokidsDir?: string;
}

export interface RunInitOptions {
  rootDir?: string;
  prompter?: Prompter;
  /** Pre-supplied answers; if a key is present here we never call prompter for it. */
  answers?: InitAnswers;
  /** Overwrite tenants/<slug>/config.json if it already exists. */
  force?: boolean;
  /** Sink for status/info lines. Default console.log. */
  writer?: (line: string) => void;
}

export interface InitReport {
  ok: boolean;
  tenantSlug: string;
  configPath: string;
  dataDir: string;
  error?: string;
}

export async function runInit(opts: RunInitOptions = {}): Promise<InitReport> {
  const root = opts.rootDir ?? config.paths.projectRoot;
  const answers = { ...(opts.answers ?? {}) };
  const writer = opts.writer ?? ((line: string) => console.log(line));
  const ask = async (key: keyof InitAnswers, question: string, optsP: Omit<PromptOptions, 'key'> = {}): Promise<string> => {
    if (answers[key] != null) return answers[key]!;
    if (!opts.prompter) {
      throw new Error(`runInit: no prompter and no preset answer for "${key}"`);
    }
    const v = await opts.prompter.ask(question, { key, ...optsP });
    answers[key] = v;
    return v;
  };

  writer('postiz-agent init: onboarding wizard');
  writer('');

  // 1. Tenant slug
  const slug = (await ask('slug', 'Tenant slug (lowercase, e.g. "audiokids", "zetaread"): ')).trim();
  if (!VALID_SLUG.test(slug)) {
    return failed(slug, root, `invalid tenant slug "${slug}". Expected lowercase alphanumeric with dashes, ≤64 chars.`);
  }

  const configPath = join(root, 'tenants', slug, 'config.json');
  const dataDir = join(root, 'data', slug);
  if (existsSync(configPath) && !opts.force) {
    return failed(slug, root, `tenant "${slug}" already exists at ${configPath}. Pass force:true to overwrite.`);
  }

  // 2. Brand
  const brandName = (await ask('brandName', `Brand display name (used in captions, default: "${slug}"): `, { default: slug })).trim() || slug;
  const hashtagsRaw = (await ask('hashtags', 'Base hashtags (comma-separated, leave empty for locale defaults): ')).trim();
  const hashtags = hashtagsRaw
    ? hashtagsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // 3. Postiz
  const postizApiUrl = (await ask('postizApiUrl', `Postiz API URL [${config.postiz.apiUrl}]: `, { default: config.postiz.apiUrl })).trim() || config.postiz.apiUrl;
  const postizApiKey = (await ask('postizApiKey', 'Postiz API key (find at <postiz>/settings/developers): ', { secret: true })).trim();

  // 4. Bundles source
  const audiokidsDir = (await ask('audiokidsDir', `Bundle source directory (where the audiokids adapter reads .json+.mp3) [${config.audiokids.outputDir}]: `, { default: config.audiokids.outputDir })).trim() || config.audiokids.outputDir;

  // 5. Write config
  const configBody: Record<string, unknown> = {
    postiz: { apiUrl: postizApiUrl, apiKey: postizApiKey },
    audiokids: { outputDir: audiokidsDir },
    brand: {
      name: brandName,
      ...(hashtags.length ? { defaultHashtags: hashtags } : {}),
    },
  };

  mkdirSync(resolve(root, 'tenants', slug), { recursive: true });
  writeFileSync(configPath, JSON.stringify(configBody, null, 2) + '\n');
  mkdirSync(dataDir, { recursive: true });

  writer('');
  writer(`✓ Created ${configPath}`);
  writer(`✓ Created ${dataDir}/`);
  writer('');
  writer('Next steps:');
  writer(`  postiz-agent doctor --tenant ${slug}      # verify setup`);
  writer(`  postiz-agent integrations --tenant ${slug}  # confirm Postiz integrations are connected`);
  writer(`  postiz-agent dispatch --tenant ${slug} --dry-run --platforms x,tiktok  # smoke a publish without uploading`);
  writer('');
  writer('To connect platforms (X, TikTok, IG, YouTube), open Postiz at the URL above and use its OAuth flows.');
  writer(`To customise CTAs, hashtags, or theme defaults later, edit ${configPath}.`);

  return { ok: true, tenantSlug: slug, configPath, dataDir };
}

function failed(slug: string, root: string, error: string): InitReport {
  return {
    ok: false,
    tenantSlug: slug,
    configPath: join(root, 'tenants', slug || '_invalid', 'config.json'),
    dataDir: join(root, 'data', slug || '_invalid'),
    error,
  };
}
