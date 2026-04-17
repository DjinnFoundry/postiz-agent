import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env') });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

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
    apiUrl: optional('AUDIOKIDS_API_URL'),
    apiKey: optional('AUDIOKIDS_API_KEY'),
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

export { required };
