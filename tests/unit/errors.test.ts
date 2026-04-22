import { describe, it, expect } from 'vitest';
import { classifyError } from '../../src/core/errors.js';

describe('classifyError: network', () => {
  it('treats ECONNRESET as transient with retry remediation', () => {
    const c = classifyError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    expect(c.kind).toBe('transient');
    expect(c.retryable).toBe(true);
    expect(c.remediation?.action).toBe('retry');
  });

  it('treats ECONNREFUSED as needs-config (service down)', () => {
    const c = classifyError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000'), { code: 'ECONNREFUSED' }));
    expect(c.kind).toBe('needs-config');
    expect(c.retryable).toBe(false);
    expect(c.remediation?.action).toBe('check-service');
  });

  it('treats ETIMEDOUT as transient', () => {
    const c = classifyError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    expect(c.kind).toBe('transient');
    expect(c.retryable).toBe(true);
  });
});

describe('classifyError: postiz', () => {
  it('401 → needs-config (update api key)', () => {
    const c = classifyError(new Error('Postiz API 401 Unauthorized'), { origin: 'postiz' });
    expect(c.kind).toBe('needs-config');
    expect(c.remediation?.action).toBe('update-api-key');
  });

  it('403 pay-per-use → needs-config (fund or upgrade)', () => {
    const c = classifyError(new Error('403 Forbidden: pay-per-use plan required'), { origin: 'postiz' });
    expect(c.kind).toBe('needs-config');
    expect(c.remediation?.action).toBe('fund-or-upgrade-postiz');
  });

  it('integration not found → reconnect-integration', () => {
    const c = classifyError(new Error('integration not found for platform x'), { origin: 'postiz' });
    expect(c.kind).toBe('needs-config');
    expect(c.remediation?.action).toBe('reconnect-integration');
  });

  it('429 → transient with retry', () => {
    const c = classifyError(new Error('Postiz returned 429 Too Many Requests'), { origin: 'postiz' });
    expect(c.kind).toBe('transient');
    expect(c.retryable).toBe(true);
  });

  it('5xx → transient with retry', () => {
    const c = classifyError(new Error('Postiz 502 Bad Gateway'), { origin: 'postiz' });
    expect(c.kind).toBe('transient');
  });

  it('generic 4xx other → permanent', () => {
    const c = classifyError(new Error('Postiz 422 Unprocessable Entity'), { origin: 'postiz' });
    expect(c.kind).toBe('permanent');
    expect(c.retryable).toBe(false);
  });
});

describe('classifyError: whisper', () => {
  it('model missing → needs-config with download hint', () => {
    const c = classifyError(new Error('whisper model not found at ~/.cache/whisper/base.pt'), { origin: 'whisper' });
    expect(c.kind).toBe('needs-config');
    expect(c.remediation?.action).toBe('download-whisper-model');
  });

  it('audio missing → permanent', () => {
    const c = classifyError(new Error('Audio not found: /tmp/x.mp3'), { origin: 'whisper' });
    expect(c.kind).toBe('permanent');
    expect(c.remediation?.action).toBe('regenerate-source');
  });
});

describe('classifyError: hyperframes', () => {
  it('missing template → add-template', () => {
    const c = classifyError(new Error('No HyperFrames template for mood=zine'), { origin: 'hyperframes' });
    expect(c.kind).toBe('permanent');
    expect(c.remediation?.action).toBe('add-template');
  });

  it('lint error → fix-template', () => {
    const c = classifyError(new Error('hyperframes lint: validation failed on clip #3'), { origin: 'hyperframes' });
    expect(c.remediation?.action).toBe('fix-template');
  });

  it('no render output → fix-template', () => {
    const c = classifyError(new Error('hyperframes render produced no output'), { origin: 'hyperframes' });
    expect(c.remediation?.action).toBe('fix-template');
  });
});

describe('classifyError: youtube-cli', () => {
  it('unparseable videoId → needs-human', () => {
    const c = classifyError(new Error('Could not parse videoId from YouTubeCLI output: ...'), { origin: 'youtube-cli' });
    expect(c.kind).toBe('needs-human');
    expect(c.remediation?.action).toBe('inspect-youtubecli-output');
  });

  it('path not found → needs-config', () => {
    const c = classifyError(new Error('YouTubeCLI path not found: /opt/missing'), { origin: 'youtube-cli' });
    expect(c.kind).toBe('needs-config');
  });
});

describe('classifyError: generic', () => {
  it('ENOENT → permanent regenerate-source', () => {
    const c = classifyError(new Error('ENOENT: no such file or directory, open \'/tmp/x\''));
    expect(c.kind).toBe('permanent');
    expect(c.remediation?.action).toBe('regenerate-source');
  });

  it('Invalid slug → permanent fix-input', () => {
    const c = classifyError(new Error('Invalid slug: must match pattern'));
    expect(c.kind).toBe('permanent');
    expect(c.remediation?.action).toBe('fix-input');
  });

  it('bare network signal → transient', () => {
    const c = classifyError(new Error('socket hang up'));
    expect(c.kind).toBe('transient');
  });

  it('truly unknown → unknown + not retryable', () => {
    const c = classifyError(new Error('something weird happened'));
    expect(c.kind).toBe('unknown');
    expect(c.retryable).toBe(false);
  });
});
