import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { runInit, type Prompter } from '../init.js';
import { CliError } from '../errors.js';

/**
 * `init`: onboarding wizard for a new tenant. Creates tenants/<slug>/config.json
 * (brand identity + Postiz creds + audiokids dir) and data/<slug>/. Every
 * answer is overridable via flags so an external orchestrator can drive a
 * non-interactive install (--non-interactive forces the run to fail rather
 * than block on a missing answer).
 */
export function register(program: Command): void {
  program
    .command('init')
    .description('Onboarding wizard: create a new tenant with its brand identity, Postiz credentials, and data dir')
    .option('--force', 'overwrite an existing tenant config without prompting', false)
    .option('--non-interactive', 'fail if any required answer is missing instead of prompting', false)
    .option('--slug <slug>', 'pre-fill tenant slug')
    .option('--brand-name <name>', 'pre-fill brand display name')
    .option('--hashtags <csv>', 'pre-fill comma-separated base hashtags')
    .option('--postiz-api-url <url>', 'pre-fill Postiz API URL')
    .option('--postiz-api-key <key>', 'pre-fill Postiz API key')
    .option('--audiokids-dir <path>', 'pre-fill bundle source directory')
    .addHelpText('after', `
Creates tenants/<slug>/config.json (brand identity + Postiz credentials +
audiokids dir) and data/<slug>/ (isolated decisions / caches / logs).

Examples:
  postiz-agent init                              # interactive
  postiz-agent init --slug zetaread --brand-name ZetaRead --hashtags booklovers,reading \\
    --postiz-api-key sk-xx --audiokids-dir /home/juan/zetaread/output
`)
    .action(async (opts: {
      force?: boolean;
      nonInteractive?: boolean;
      slug?: string;
      brandName?: string;
      hashtags?: string;
      postizApiUrl?: string;
      postizApiKey?: string;
      audiokidsDir?: string;
    }) => {
      const prompter: Prompter = {
        async ask(question, askOpts) {
          if (opts.nonInteractive) {
            if (askOpts?.default !== undefined) return askOpts.default;
            throw new Error(`init --non-interactive: missing answer for ${askOpts?.key ?? question}`);
          }
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const ans = await rl.question(question);
            return ans || (askOpts?.default ?? '');
          } finally {
            rl.close();
          }
        },
      };
      const report = await runInit({
        prompter,
        force: opts.force,
        answers: {
          ...(opts.slug ? { slug: opts.slug } : {}),
          ...(opts.brandName ? { brandName: opts.brandName } : {}),
          ...(opts.hashtags != null ? { hashtags: opts.hashtags } : {}),
          ...(opts.postizApiUrl ? { postizApiUrl: opts.postizApiUrl } : {}),
          ...(opts.postizApiKey ? { postizApiKey: opts.postizApiKey } : {}),
          ...(opts.audiokidsDir ? { audiokidsDir: opts.audiokidsDir } : {}),
        },
      });
      if (!report.ok) {
        throw new CliError(`init failed: ${report.error}`);
      }
    });
}
