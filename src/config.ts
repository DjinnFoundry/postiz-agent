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
  alerts: {
    webhookUrl: optional('ALERT_WEBHOOK_URL'),
  },
  paths: {
    projectRoot: resolve(__dirname, '..'),
    binDir: resolve(__dirname, '..', 'bin'),
    tmpDir: resolve(__dirname, '..', 'tmp'),
    assetsDir: resolve(__dirname, '..', 'assets'),
  },
};

/**
 * Throws with a clear message when the Postiz public API key is missing, or
 * when the configured API URL would send that key over cleartext HTTP to a
 * non-localhost host. Set POSTIZ_ALLOW_INSECURE=1 to opt out of the TLS check
 * (only for trusted private networks).
 */
export function assertPostizConfigured(): void {
  if (!config.postiz.apiKey) {
    throw new Error(
      `POSTIZ_API_KEY is not set. Add it to .env (see .env.example). ` +
      `You can find your key at ${config.postiz.apiUrl.replace(/\/public\/v1$/, '')}/settings/developers.`,
    );
  }
  if (process.env.POSTIZ_ALLOW_INSECURE === '1') return;
  const url = new URL(config.postiz.apiUrl);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error(
      `POSTIZ_API_URL is http:// on a non-localhost host (${url.hostname}). ` +
      `Your API key would ride in cleartext. Use https:// or set ` +
      `POSTIZ_ALLOW_INSECURE=1 to override for a trusted private network.`,
    );
  }
}
