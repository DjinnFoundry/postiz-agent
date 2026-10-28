import type { Command } from 'commander';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseApprovedJson, runApprovedMedia, type ApprovedMediaOptions } from './approved-media.js';

/** Register without reading credentials or constructing a network client. */
export function registerApprovedMediaCommand(program: Command, execute = runApprovedMedia): void {
  program.command('publish-approved')
    .description('Submit an approved MP4 or ordered image collection; never transcribe or render')
    .requiredOption('--manifest <path>', 'approved bundle manifest with relative media paths and SHA-256 hashes')
    .requiredOption('--integration-id <id>', 'exact Postiz account/integration ID')
    .requiredOption('--provider <provider>', 'instagram, instagram-standalone or tiktok')
    .requiredOption('--mode <mode>', 'now, schedule or draft; no implicit publication mode')
    .requiredOption('--settings-file <path>', 'explicit provider settings JSON, including __type')
    .requiredOption('--state-dir <path>', 'private durable receipts and scoped locks directory')
    .option('--date <iso>', 'required for schedule, omitted for now/draft')
    .option('--allow-publish', 'authorize media upload and post creation; omitted means local validation only', false)
    .option('--reconcile', 'GET readback of an existing recorded post only; never resend', false)
    .option('--poll-attempts <count>', 'bounded readback attempts, 1..10', '1')
    .option('--poll-interval-ms <milliseconds>', 'bounded delay between readback attempts', '1000')
    .action(async opts => {
      try {
        const fd = openSync(resolve(opts.settingsFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let settings: unknown;
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || info.size > 1024 * 1024) throw new Error('invalid_settings_file');
          settings = parseApprovedJson(readFileSync(fd, 'utf8'));
        } finally { closeSync(fd); }
        const result = await execute(resolve(opts.manifest), {
          integrationId: opts.integrationId, provider: opts.provider, mode: opts.mode, date: opts.date,
          settings, stateDir: resolve(opts.stateDir), allowPublish: opts.allowPublish, reconcile: opts.reconcile,
          poll: { maxAttempts: Number(opts.pollAttempts), intervalMs: Number(opts.pollIntervalMs) },
        } as ApprovedMediaOptions);
        process.stdout.write(JSON.stringify(result) + '\n');
        if (result.state === 'needs_reconciliation') process.exitCode = 2;
        if (result.state === 'failed') process.exitCode = 1;
      } catch (error) {
        const code = error instanceof Error ? error.message : 'approved_media_failed';
        process.stderr.write(JSON.stringify({ state: 'blocked', code }) + '\n');
        process.exitCode = 1;
      }
    });
}
