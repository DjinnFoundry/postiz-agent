import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { config, assertPostizConfigured } from '../config.js';
import type { Platform } from '../types.js';

// Postiz uses these identifiers in its `integration` field when creating posts.
// See https://docs.postiz.com/public-api/providers/
const POSTIZ_PROVIDER_KEY: Record<Platform, string | null> = {
  x: 'x',
  tiktok: 'tiktok',
  instagram: 'instagram',
  youtube: 'youtube',
  spotify: null,
};

export interface PostizMediaUpload {
  id: string;
  path: string;
  url?: string;
}

export interface PostizIntegration {
  id: string;
  name: string;
  providerIdentifier: string;
  disabled: boolean;
}

export interface CreatePostInput {
  platform: Platform;
  integrationId: string;
  text: string;
  videoPath?: string;
  scheduledDate?: string;
  platformSettings?: Record<string, unknown>;
}

export interface CreatePostResult {
  postId: string;
  url?: string;
  scheduledDate: string;
}

export class PostizClient {
  constructor(
    private readonly apiUrl: string = config.postiz.apiUrl,
    private readonly apiKey: string = config.postiz.apiKey,
  ) {
    assertPostizConfigured();
  }

  private async request<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
    const headers: Record<string, string> = {
      'Authorization': this.apiKey,
    };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = contentType;
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.apiUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Postiz ${method} ${path} failed [${res.status}]: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) as T : ({} as T);
  }

  async listIntegrations(): Promise<PostizIntegration[]> {
    return this.request<PostizIntegration[]>('GET', '/integrations');
  }

  async findIntegration(platform: Platform): Promise<PostizIntegration> {
    const key = POSTIZ_PROVIDER_KEY[platform];
    if (!key) throw new Error(`Platform ${platform} is not supported by Postiz`);
    const integrations = await this.listIntegrations();
    const found = integrations.find(i => i.providerIdentifier === key && !i.disabled);
    if (!found) throw new Error(`No connected Postiz integration for ${platform}. Connect via the Postiz UI first.`);
    return found;
  }

  async uploadMedia(filePath: string): Promise<PostizMediaUpload> {
    const buf = readFileSync(filePath);
    const name = basename(filePath);
    const stat = statSync(filePath);
    const form = new FormData();
    const blob = new Blob([buf]);
    form.append('file', blob, name);
    const result = await this.request<{ id: string; path: string; url?: string }>(
      'POST', '/upload', form,
    );
    console.log(`uploaded ${name} (${stat.size}B) → ${result.id}`);
    return result;
  }

  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    const media: Array<{ id: string; path: string }> = [];
    if (input.videoPath) media.push(await this.uploadMedia(input.videoPath));

    const scheduledDate = input.scheduledDate ?? new Date().toISOString();
    const key = POSTIZ_PROVIDER_KEY[input.platform]!;

    const body = {
      type: 'now' as const,
      date: scheduledDate,
      shortLink: false,
      tags: [] as string[],
      posts: [{
        integration: { id: input.integrationId },
        value: [{
          content: input.text,
          image: media,
        }],
        group: 'default',
        settings: {
          [key]: input.platformSettings ?? {},
        },
      }],
    };

    const resp = await this.request<{ posts?: Array<{ id: string; url?: string }> }>(
      'POST', '/posts', body,
    );
    const post = resp.posts?.[0];
    if (!post?.id) throw new Error(`Postiz did not return a post id: ${JSON.stringify(resp).slice(0, 300)}`);
    return { postId: post.id, url: post.url, scheduledDate };
  }
}
