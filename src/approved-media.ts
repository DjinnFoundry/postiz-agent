/** Publish already-approved bytes. No renderer, narration, split or generated copy. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CreateMediaPostInput, CreatePostResult, PostizIntegration, PostizMediaUpload, PostizMode,
  PostizPost, PostizWindow } from './platforms/postiz.js';

type Provider = 'instagram' | 'instagram-standalone' | 'tiktok';
type Media = { path: string; sha256: string; mimeType: 'video/mp4' | 'image/png' | 'image/jpeg';
  role: 'video' | 'cover' | 'page' | 'question'; pageNumber?: number };
interface Manifest {
  schemaVersion: 1; storyId: string; revision: string; kind: 'video' | 'image_collection'; media: Media[];
  metadata: { title: string; description: string; language: string; tags: string[]; madeForKids?: boolean };
  approval: { status: 'pending' | 'approved'; bundleSha256: string; approvedAt?: string };
}
export interface ApprovedMediaClient {
  readonly scope?: string;
  getIntegration(id: string): Promise<PostizIntegration>;
  uploadMedia(path: string, mimeType?: string, expectedSha256?: string): Promise<PostizMediaUpload>;
  createMediaPost(input: CreateMediaPostInput): Promise<CreatePostResult>;
  getPost(postId: string, integrationId: string, window: PostizWindow): Promise<PostizPost | null>;
}
export interface ApprovedMediaOptions {
  integrationId: string; provider: Provider; mode: PostizMode; date?: string;
  settings: Record<string, unknown>; stateDir: string; allowPublish?: boolean; reconcile?: boolean;
  client?: ApprovedMediaClient; now?: () => Date;
  poll?: { maxAttempts?: number; intervalMs?: number; sleep?: (milliseconds: number) => Promise<void> };
}
type State = 'prepared' | 'uploading' | 'creating' | 'accepted' | 'scheduled' | 'draft'
  | 'awaiting_manual_publish' | 'published' | 'needs_reconciliation' | 'failed';
interface Receipt {
  version: 1; attemptKey: string; scope: string; requestSha256: string; intent: Record<string, unknown>;
  state: State; createdAt: string; updatedAt: string;
  media: Array<{ index: number; sha256: string; status: 'not_started' | 'started' | 'uploaded'; remote?: PostizMediaUpload }>;
  activeEffect?: { kind: 'media_upload' | 'post_create'; index?: number };
  postId?: string; candidatePostIds?: string[]; readback?: { state: string; integrationId: string; provider: string; url?: string; verifiedAt: string };
  errorCode?: string;
}
export interface ApprovedMediaResult {
  state: State | 'ready_for_authorization'; attemptKey?: string; receipt?: string; postId?: string;
  media?: PostizMediaUpload[]; candidatePostIds?: string[]; publicationVerified: boolean; remoteMutationStarted: boolean; errorCode?: string;
}
const object = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4000): v is string => typeof v === 'string' && Boolean(v.trim()) && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function fail(code: string): never { throw new Error(code); }
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function zonedIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value)) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  const day = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === match[1];
}

/** JSON.parse alone discards repeated fields. Scan valid JSON tokens before use. */
export function parseApprovedJson(raw: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail('invalid_approved_json'); }
  const stack: Array<{ object: boolean; keys: Set<string>; key: boolean }> = [];
  for (const match of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],]/g)) {
    const token = match[0];
    if (token === '{' || token === '[') {
      if (stack.length >= 64) fail('json_depth_limit');
      stack.push({ object: token === '{', keys: new Set(), key: true });
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (stack.at(-1)?.object) stack.at(-1)!.key = true; }
    else if (stack.at(-1)?.object && stack.at(-1)!.key) {
      const key = JSON.parse(token) as string; const current = stack.at(-1)!;
      if (current.keys.has(key)) fail('duplicate_approved_json_key');
      current.keys.add(key); current.key = false;
    }
  }
  canonicalBundleJson(value); // Also rejects numeric overflow such as 1e999.
  return value;
}

/** Matches sorted-key, compact UTF-8 JSON used by the producer's bundle digest. */
export function canonicalBundleJson(value: unknown, depth = 0): string {
  if (depth > 64) fail('json_depth_limit');
  if (Array.isArray(value)) return `[${value.map(v => canonicalBundleJson(v, depth + 1)).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalBundleJson(value[k], depth + 1)}`).join(',')}}`;
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  return fail('nonfinite_or_non_json_value');
}

function noLinks(path: string): string {
  if (path.split(/[\\/]/).includes('..')) fail('parent_traversal_forbidden');
  let cursor = resolve(path);
  for (;;) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('symlink_forbidden');
    // existsSync is false for a dangling symlink; lstat still detects it.
    try { if (lstatSync(cursor).isSymbolicLink()) fail('symlink_forbidden'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return resolve(path);
}
function readOwned(path: string, maxBytes: number): Buffer {
  noLinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) fail('unsafe_or_oversized_file');
    const data = readFileSync(fd); const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || data.length !== after.size) fail('file_changed_during_read');
    return data;
  } finally { closeSync(fd); }
}
function checkMedia(base: string, item: Media): string {
  if (isAbsolute(item.path) || item.path.includes('\\') || item.path.split('/').some(p => !p || p === '.' || p === '..')) fail('unsafe_media_path');
  const path = noLinks(join(base, item.path));
  if (!relative(base, path) || relative(base, path).startsWith('..' + sep)) fail('media_path_escape');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) fail('unsafe_or_oversized_media');
    const digest = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let length = 0; let header = Buffer.alloc(0);
    for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
      if (!length) header = Buffer.from(buffer.subarray(0, Math.min(count, 16)));
      digest.update(buffer.subarray(0, count)); length += count; }
    const after = fstatSync(fd);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('media_changed_during_read');
    if (digest.digest('hex') !== item.sha256) fail('media_hash_mismatch');
    const extension = extname(path).toLowerCase();
    const valid = item.mimeType === 'video/mp4' ? extension === '.mp4' && header.subarray(4, 8).toString() === 'ftyp'
      : item.mimeType === 'image/png' ? extension === '.png' && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : ['.jpg', '.jpeg'].includes(extension) && header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    if (!valid) fail('media_type_mismatch');
  } finally { closeSync(fd); }
  return path;
}

export function validateApprovedManifest(manifestPath: string): { manifest: Manifest; paths: string[]; sourceSha256: string } {
  const path = noLinks(manifestPath); const bytes = readOwned(path, 1024 * 1024);
  const raw = parseApprovedJson(bytes.toString('utf8'));
  if (!object(raw) || raw.schemaVersion !== 1 || !text(raw.storyId, 200) || !hex(raw.revision)
      || !['video', 'image_collection'].includes(raw.kind) || !Array.isArray(raw.media) || !raw.media.length || raw.media.length > 35
      || !object(raw.metadata) || !object(raw.approval)) fail('invalid_approved_manifest');
  if (Object.keys(raw).some(k => !['schemaVersion', 'storyId', 'revision', 'kind', 'media', 'metadata', 'approval'].includes(k))) fail('unknown_manifest_field');
  const m = raw.metadata;
  if (!text(m.title, 1000) || typeof m.description !== 'string' || m.description.length > 10000
      || !text(m.language, 40) || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(m.language)
      || !Array.isArray(m.tags) || m.tags.length > 100 || m.tags.some((tag: unknown) => !text(tag, 100))
      || (m.madeForKids !== undefined && typeof m.madeForKids !== 'boolean')
      || Object.keys(m).some(k => !['title', 'description', 'language', 'tags', 'madeForKids'].includes(k))) fail('invalid_approved_metadata');
  let page = 0; const mediaPaths = new Set<string>();
  for (const item of raw.media) {
    if (!object(item) || !text(item.path, 4096) || !hex(item.sha256) || !['video/mp4', 'image/png', 'image/jpeg'].includes(item.mimeType)
        || !['video', 'cover', 'page', 'question'].includes(item.role)
        || Object.keys(item).some(k => !['path', 'sha256', 'mimeType', 'role', 'pageNumber'].includes(k))) fail('invalid_approved_media');
    if (mediaPaths.has(item.path)) fail('duplicate_media_path');
    mediaPaths.add(item.path);
    if (item.role === 'page') { page++; if (item.pageNumber !== undefined && item.pageNumber !== page) fail('invalid_page_order'); }
    else if (item.pageNumber !== undefined) fail('page_number_requires_page_role');
    if (raw.kind === 'video' ? raw.media.length !== 1 || item.mimeType !== 'video/mp4' || item.role !== 'video'
      : item.mimeType === 'video/mp4' || item.role === 'video') fail('media_kind_mismatch');
  }
  const { approval, ...body } = raw;
  if (approval.status !== 'approved' || !hex(approval.bundleSha256) || approval.bundleSha256 !== hash(canonicalBundleJson(body))
      || !zonedIso(approval.approvedAt) || Date.parse(approval.approvedAt) > Date.now()) fail('approved_bundle_digest_required');
  const manifest = raw as Manifest;
  const paths = manifest.media.map(item => checkMedia(dirname(path), item));
  const identities = paths.map(p => { const info = lstatSync(p); return `${info.dev}:${info.ino}`; });
  if (new Set(identities).size !== identities.length) fail('duplicate_media_path_identity');
  return { manifest, paths, sourceSha256: hash(bytes) };
}

function validateOptions(options: ApprovedMediaOptions): void {
  if ([options.allowPublish, options.reconcile].some(value => value !== undefined && typeof value !== 'boolean')) fail('authorization_flags_must_be_boolean');
  if (!text(options.integrationId, 300) || !['instagram', 'instagram-standalone', 'tiktok'].includes(options.provider)
      || !['now', 'schedule', 'draft'].includes(options.mode) || !object(options.settings) || options.settings.__type !== options.provider) fail('explicit_publication_settings_required');
  if (options.mode === 'schedule' ? !zonedIso(options.date) : options.date !== undefined) fail('explicit_schedule_date_required');
  if (options.provider.startsWith('instagram')) {
    if (options.settings.post_type !== 'post') fail('instagram_feed_post_required');
    if (Object.keys(options.settings).some(k => !['__type', 'post_type', 'is_trial_reel', 'graduation_strategy', 'collaborators', 'audio'].includes(k))) fail('unknown_instagram_setting');
    if (options.settings.is_trial_reel !== undefined && typeof options.settings.is_trial_reel !== 'boolean') fail('invalid_instagram_settings');
    if (options.settings.graduation_strategy !== undefined && (!options.settings.is_trial_reel
      || !['MANUAL', 'SS_PERFORMANCE'].includes(String(options.settings.graduation_strategy)))) fail('invalid_instagram_settings');
    if (options.settings.collaborators !== undefined && (!Array.isArray(options.settings.collaborators)
      || options.settings.collaborators.length > 20 || options.settings.collaborators.some(item => !object(item)
        || Object.keys(item).some(k => k !== 'label') || !text(item.label, 100)))) fail('invalid_instagram_collaborators');
    if (options.settings.audio !== undefined) {
      const a = options.settings.audio;
      if (options.provider !== 'instagram' || !object(a) || !text(a.id, 300)
        || Object.keys(a).some(k => !['id', 'title', 'artist', 'image', 'audio_volume', 'video_volume'].includes(k))
        || ['audio_volume', 'video_volume'].some(k => a[k] !== undefined && (typeof a[k] !== 'number' || a[k] < 0 || a[k] > 100))) fail('invalid_instagram_audio');
    }
  } else {
    const s = options.settings;
    if (Object.keys(s).some(k => !['__type', 'title', 'privacy_level', 'duet', 'stitch', 'comment', 'autoAddMusic',
      'brand_content_toggle', 'brand_organic_toggle', 'video_made_with_ai', 'content_posting_method'].includes(k))) fail('unknown_tiktok_setting');
    if (!['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(String(s.privacy_level))
        || !['DIRECT_POST', 'UPLOAD'].includes(String(s.content_posting_method)) || !['yes', 'no'].includes(String(s.autoAddMusic))
        || ['duet', 'stitch', 'comment', 'brand_content_toggle', 'brand_organic_toggle'].some(k => typeof s[k] !== 'boolean')
        || (s.video_made_with_ai !== undefined && typeof s.video_made_with_ai !== 'boolean')) fail('explicit_tiktok_settings_required');
  }
  canonicalBundleJson(options.settings);
  const attempts = options.poll?.maxAttempts ?? 1; const interval = options.poll?.intervalMs ?? 1000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10 || !Number.isFinite(interval) || interval < 0 || interval > 30000) fail('invalid_poll_budget');
}
function atomicState(path: string, value: Receipt): void {
  noLinks(path); const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path); const dir = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function result(receipt: Receipt, path: string): ApprovedMediaResult {
  return { state: receipt.state, attemptKey: receipt.attemptKey, receipt: path, postId: receipt.postId,
    ...(receipt.candidatePostIds ? { candidatePostIds: receipt.candidatePostIds } : {}),
    media: receipt.media.flatMap(item => item.remote ? [item.remote] : []), publicationVerified: receipt.state === 'published',
    remoteMutationStarted: receipt.media.some(item => item.status !== 'not_started') || Boolean(receipt.postId), errorCode: receipt.errorCode };
}
function verifiedRelease(post: PostizPost, provider: Provider): boolean {
  if (!post.releaseURL) return false;
  try {
    const url = new URL(post.releaseURL);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
    return provider.startsWith('instagram') ? ['instagram.com', 'www.instagram.com'].includes(url.hostname) && /^\/(?:reel|p)\/[^/]+\/?$/.test(url.pathname)
      : ['tiktok.com', 'www.tiktok.com'].includes(url.hostname) && /^\/@[^/]+\/(?:video|photo)\/\d+\/?$/.test(url.pathname);
  } catch { return false; }
}

export async function runApprovedMedia(manifestPath: string, options: ApprovedMediaOptions): Promise<ApprovedMediaResult> {
  const { manifest, paths, sourceSha256 } = validateApprovedManifest(manifestPath); validateOptions(options);
  // Caller-owned objects must not change the frozen intent during async preflight.
  options = { ...options, settings: parseApprovedJson(canonicalBundleJson(options.settings)) as Record<string, unknown>,
    poll: options.poll ? { ...options.poll } : undefined };
  if (manifest.kind === 'image_collection' && (options.settings.audio !== undefined || options.settings.is_trial_reel === true)) fail('video_only_instagram_setting');
  if (options.allowPublish !== true && options.reconcile !== true) return { state: 'ready_for_authorization', publicationVerified: false, remoteMutationStarted: false };
  const approvalUnchanged = () => {
    try { return hash(readOwned(manifestPath, 1024 * 1024)) === sourceSha256; }
    catch { return false; }
  };
  const client = options.client ?? new (await import('./platforms/postiz.js')).PostizClient();
  const now = options.now ?? (() => new Date()); const scope = client.scope ?? 'injected-client';
  const identity = { storyId: manifest.storyId, revision: manifest.revision, media: manifest.media.map(m => m.sha256),
    provider: options.provider, integrationId: options.integrationId, scope };
  const intent = { ...identity, bundleSha256: manifest.approval.bundleSha256, metadata: manifest.metadata,
    mode: options.mode, date: options.date ?? null, settings: options.settings };
  const attemptKey = hash(canonicalBundleJson(identity)); const requestSha256 = hash(canonicalBundleJson(intent));
  const stateDir = noLinks(options.stateDir); mkdirSync(stateDir, { recursive: true, mode: 0o700 }); noLinks(stateDir);
  const path = join(stateDir, `${attemptKey}.json`); const lock = join(stateDir, `${attemptKey}.lock`);
  noLinks(lock);
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('approved_media_locked_recovery_required'); throw error;
  }
  try {
    let receipt: Receipt;
    const existing = existsSync(path);
    if (existing) {
      receipt = parseApprovedJson(readOwned(path, 1024 * 1024).toString('utf8')) as Receipt;
      if (receipt.version !== 1 || receipt.attemptKey !== attemptKey || receipt.scope !== scope
          || receipt.requestSha256 !== requestSha256 || hash(canonicalBundleJson(receipt.intent)) !== requestSha256
          || !Array.isArray(receipt.media) || receipt.media.length !== manifest.media.length
          || receipt.media.some((m, i) => m.index !== i || m.sha256 !== manifest.media[i].sha256
            || !['not_started', 'started', 'uploaded'].includes(m.status)
            || (m.status === 'uploaded' && (!m.remote || !text(m.remote.id) || !text(m.remote.path))))) fail('approved_media_intent_conflict');
      if (!['prepared', 'uploading', 'creating', 'accepted', 'scheduled', 'draft', 'awaiting_manual_publish', 'published', 'needs_reconciliation', 'failed'].includes(receipt.state)) fail('invalid_publication_receipt_state');
      if (receipt.state === 'published' && (!text(receipt.postId) || receipt.readback?.state !== 'PUBLISHED'
        || receipt.readback.integrationId !== options.integrationId || receipt.readback.provider !== options.provider
        || !verifiedRelease({ id: receipt.postId, state: 'PUBLISHED', releaseURL: receipt.readback.url,
          integration: { id: options.integrationId, providerIdentifier: options.provider } }, options.provider))) fail('publication_receipt_evidence_missing');
    } else {
      if (options.reconcile) fail('reconciliation_requires_existing_receipt');
      if (options.mode === 'schedule' && Date.parse(options.date!) <= now().getTime()) fail('schedule_date_must_be_future');
      receipt = { version: 1, attemptKey, scope, requestSha256, intent, state: 'prepared', createdAt: now().toISOString(), updatedAt: now().toISOString(),
        media: manifest.media.map((m, index) => ({ index, sha256: m.sha256, status: 'not_started' })) };
      atomicState(path, receipt);
    }
    const save = () => { receipt.updatedAt = now().toISOString(); atomicState(path, receipt); };
    const uncertain = (code: string) => { receipt.state = 'needs_reconciliation'; receipt.errorCode = code; save(); return result(receipt, path); };
    if ((receipt.activeEffect && !(options.reconcile && receipt.activeEffect.kind === 'post_create' && receipt.postId))
        || receipt.media.some(item => item.status === 'started')) return uncertain('unfinished_external_effect');
    if (existing && (options.reconcile ? !receipt.postId : Boolean(receipt.postId) || receipt.state === 'needs_reconciliation')) return result(receipt, path);
    if (!receipt.postId && !options.reconcile) {
      const integration = await client.getIntegration(options.integrationId);
      if (integration.id !== options.integrationId || integration.providerIdentifier !== options.provider || integration.disabled !== false) fail('explicit_account_identity_mismatch');
      for (const [index, item] of manifest.media.entries()) {
        if (receipt.media[index].status === 'uploaded') continue;
        checkMedia(dirname(resolve(manifestPath)), item); // Recheck after authenticated preflight, before any upload.
        if (!approvalUnchanged()) return uncertain('approval_changed_before_media_upload');
        receipt.media[index].status = 'started'; receipt.activeEffect = { kind: 'media_upload', index }; receipt.state = 'uploading'; save();
        if (!approvalUnchanged()) return uncertain('approval_changed_before_media_upload');
        try {
          const uploaded = await client.uploadMedia(paths[index], item.mimeType, item.sha256);
          if (text(uploaded.id)) receipt.media[index].remote = { id: uploaded.id, path: typeof uploaded.path === 'string' ? uploaded.path : '' };
          if (!text(uploaded.id) || !text(uploaded.path)) throw new Error('invalid_media_receipt');
          receipt.media[index].remote = { id: uploaded.id, path: uploaded.path }; receipt.media[index].status = 'uploaded';
          delete receipt.activeEffect; save();
        } catch (error) {
          if (object(error) && object(error.media) && text(error.media.id)) receipt.media[index].remote = {
            id: error.media.id, path: typeof error.media.path === 'string' ? error.media.path : '' };
          return uncertain('media_upload_outcome_uncertain');
        }
      }
      if (!approvalUnchanged()) return uncertain('approval_changed_before_post_create');
      receipt.activeEffect = { kind: 'post_create' }; receipt.state = 'creating'; save();
      if (!approvalUnchanged()) return uncertain('approval_changed_before_post_create');
      try {
        const posted = await client.createMediaPost({ provider: options.provider, integrationId: options.integrationId, mode: options.mode,
          date: options.date, settings: options.settings, text: manifest.metadata.description, media: receipt.media.map(item => item.remote!) });
        if (text(posted.postId)) receipt.postId = posted.postId;
        if (!text(posted.postId) || (posted.integrationId !== undefined && posted.integrationId !== options.integrationId)) throw new Error('invalid_post_receipt');
        receipt.postId = posted.postId; receipt.state = 'accepted'; delete receipt.activeEffect; save();
      } catch (error) {
        if (object(error) && Array.isArray(error.postIds)) {
          receipt.candidatePostIds = error.postIds.filter((id: unknown): id is string => text(id, 300));
          if (receipt.candidatePostIds.length === 1) receipt.postId = receipt.candidatePostIds[0];
        }
        return uncertain('post_create_outcome_uncertain');
      }
    }
    if (!receipt.postId) return result(receipt, path);
    const window = { startDate: new Date(Date.parse(receipt.createdAt) - 86400000).toISOString(),
      endDate: new Date(Math.max(now().getTime(), options.date ? Date.parse(options.date) : 0) + 86400000).toISOString() };
    for (let attempt = 0; attempt < (options.poll?.maxAttempts ?? 1); attempt++) {
      let post: PostizPost | null;
      try { post = await client.getPost(receipt.postId, options.integrationId, window); }
      catch { return uncertain('readback_unavailable'); }
      if (post) {
        if (post.id !== receipt.postId || post.integration.id !== options.integrationId || post.integration.providerIdentifier !== options.provider) return uncertain('readback_identity_mismatch');
        receipt.readback = { state: post.state, integrationId: post.integration.id, provider: post.integration.providerIdentifier,
          ...(post.releaseURL ? { url: post.releaseURL } : {}), verifiedAt: now().toISOString() };
        delete receipt.errorCode;
        delete receipt.activeEffect;
        if (post.error) receipt.state = 'failed';
        else if (post.state === 'PUBLISHED') {
          if (options.provider === 'tiktok' && options.settings.content_posting_method === 'UPLOAD') receipt.state = 'awaiting_manual_publish';
          else if (options.mode === 'draft') return uncertain('unexpected_draft_publication');
          else if (options.provider === 'tiktok' && post.settings?.content_posting_method !== 'DIRECT_POST') return uncertain('tiktok_publication_method_unverified');
          else if (verifiedRelease(post, options.provider)) receipt.state = 'published';
          else return uncertain('publication_release_evidence_missing');
        } else if (post.state === 'ERROR' || post.error) receipt.state = 'failed';
        else if (post.state === 'DRAFT' && options.mode === 'draft') receipt.state = 'draft';
        else if (post.state === 'QUEUE' && options.mode === 'schedule') receipt.state = 'scheduled';
        else receipt.state = 'accepted';
        save();
        if (['published', 'awaiting_manual_publish', 'failed', 'draft', 'scheduled'].includes(receipt.state)) break;
      }
      if (attempt + 1 < (options.poll?.maxAttempts ?? 1)) await (options.poll?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(options.poll?.intervalMs ?? 1000);
    }
    return result(receipt, path);
  } finally { rmdirSync(lock); }
}
