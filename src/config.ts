import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env') });

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  postiz: {
    apiUrl: optional('POSTIZ_API_URL', 'http://localhost:5000/public/v1'),
    apiKey: optional('POSTIZ_API_KEY'),
  },
  audiokids: {
    outputDir: optional('AUDIOKIDS_OUTPUT_DIR', resolve(__dirname, '..', '..', 'audiokids', 'output')),
  },
  youtubecli: {
    path: optional('YOUTUBECLI_PATH', resolve(__dirname, '..', '..', 'youtubecli')),
  },
  spotify: {
    r2Bucket: optional('SPOTIFY_RSS_R2_BUCKET'),
    publicFeedUrl: optional('SPOTIFY_RSS_PUBLIC_URL'),
  },
  paths: {
    projectRoot: resolve(__dirname, '..'),
    binDir: resolve(__dirname, '..', 'bin'),
    tmpDir: resolve(__dirname, '..', 'tmp'),
    assetsDir: resolve(__dirname, '..', 'assets'),
  },
};

/**
 * Throws with a clear message when the Postiz public API key is missing.
 * Callers that need Postiz (publishers, integrations command) should invoke
 * this at the entry so the error surfaces before any work is done.
 */
export function assertPostizConfigured(): void {
  if (!config.postiz.apiKey) {
    throw new Error(
      `POSTIZ_API_KEY is not set. Add it to .env (see .env.example). ` +
      `You can find your key at ${config.postiz.apiUrl.replace(/\/public\/v1$/, '')}/settings/developers.`,
    );
  }
}
