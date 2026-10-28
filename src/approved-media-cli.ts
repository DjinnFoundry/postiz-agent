#!/usr/bin/env node
import { Command } from 'commander';
import { registerApprovedMediaCommand } from './approved-media-command.js';

const program = new Command().name('postiz-media').description('Publish approved finished media without rendering or transcription');
registerApprovedMediaCommand(program);
program.parseAsync(process.argv).catch(() => {
  process.stderr.write('approved_media_command_failed\n');
  process.exitCode = 1;
});
