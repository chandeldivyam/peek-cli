import {readFile, writeFile} from 'node:fs/promises';

import {
  resolveImageModelChoice,
  resolveVideoModelChoice,
} from '../generation.js';
import type {ImageCreateRequest, VideoCreateRequest} from '../generation.js';
import type {ResolvedAsset} from '../types.js';
import type {
  GeneratedBinaryOutput,
  GenerationProvider,
  GenerationProviderClient,
  ProgressReporter,
} from './types.js';

const XAI_BASE_URL = 'https://api.x.ai';
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 10 * 60_000;

interface XaiImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
}

interface XaiVideoStartResponse {
  request_id?: string;
}

interface XaiVideoPollResponse {
  status?: 'pending' | 'done' | 'expired' | 'failed';
  progress?: number;
  error?: {message?: string; code?: string} | string;
  video?: {
    url?: string;
    duration?: number;
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`xAI request failed (${response.status}): ${text}`);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

async function toDataUri(asset: ResolvedAsset): Promise<string> {
  const bytes = await readFile(asset.absolutePath);
  return `data:${asset.mimeType};base64,${bytes.toString('base64')}`;
}

function normalizeXaiImageResolution(value?: string): '1k' | '2k' | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (normalized === '1k' || normalized === '2k') {
    return normalized;
  }

  throw new Error('xAI image resolution must be 1k or 2k.');
}

function getDownloadedMimeType(response: Response, fallback: string): string {
  return response.headers.get('content-type')?.split(';')[0]?.trim() || fallback;
}

async function downloadUrl(url: string, fallbackMimeType: string): Promise<{
  bytes: Buffer;
  mimeType: string;
}> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download xAI output (${response.status}): ${await response.text()}`);
  }

  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: getDownloadedMimeType(response, fallbackMimeType),
  };
}

async function downloadUrlToFile(url: string, outputPath: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download xAI video (${response.status}): ${await response.text()}`);
  }

  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return getDownloadedMimeType(response, 'video/mp4');
}

function getVideoFailureMessage(payload: XaiVideoPollResponse): string {
  if (typeof payload.error === 'string') {
    return payload.error;
  }

  return payload.error?.message ?? payload.error?.code ?? `status ${payload.status ?? 'unknown'}`;
}

class XaiGenerationClient implements GenerationProviderClient {
  constructor(private readonly apiKey: string) {}

  async generateImages(params: {
    request: ImageCreateRequest;
    onProgress?: ProgressReporter;
  }): Promise<GeneratedBinaryOutput[]> {
    const inputAssets = params.request.inputSources.flatMap((inputSource) => inputSource.assets);
    const endpoint = inputAssets.length > 0 ? '/v1/images/edits' : '/v1/images/generations';
    const images = await Promise.all(inputAssets.map((asset) => toDataUri(asset)));

    params.onProgress?.(`Requesting xAI image generation with ${params.request.modelChoice.model}`);
    const body: Record<string, unknown> = {
      model: params.request.modelChoice.model,
      prompt: params.request.prompt,
      n: params.request.count,
      response_format: 'b64_json',
      ...(params.request.aspectRatio ? {aspect_ratio: params.request.aspectRatio} : {}),
      ...(params.request.imageSize
        ? {resolution: normalizeXaiImageResolution(params.request.imageSize)}
        : {}),
    };

    if (images.length === 1) {
      body.image = {type: 'image_url', url: images[0]};
    } else if (images.length > 1) {
      body.images = images.map((url) => ({type: 'image_url', url}));
    }

    const response = await parseJsonResponse<XaiImageResponse>(
      await fetch(`${XAI_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );

    const outputs = await Promise.all(
      (response.data ?? []).map(async (image) => {
        if (image.b64_json) {
          return {
            bytes: Buffer.from(image.b64_json, 'base64'),
            mimeType: 'image/jpeg',
            kind: 'image' as const,
          };
        }

        if (image.url) {
          const downloaded = await downloadUrl(image.url, 'image/jpeg');
          return {
            ...downloaded,
            kind: 'image' as const,
          };
        }

        throw new Error('xAI returned an image item without b64_json or url.');
      }),
    );

    if (outputs.length === 0) {
      throw new Error('xAI image generation returned no images.');
    }

    return outputs;
  }

  async generateVideo(params: {
    request: VideoCreateRequest;
    outputPath: string;
    onProgress?: ProgressReporter;
  }): Promise<{operationName?: string; mimeType: string}> {
    const endpoint = params.request.mode === 'extension'
      ? '/v1/videos/extensions'
      : '/v1/videos/generations';

    params.onProgress?.(`Starting xAI video generation with ${params.request.modelChoice.model}`);
    const body: Record<string, unknown> = {
      model: params.request.modelChoice.model,
      prompt: params.request.prompt,
      ...(params.request.mode !== 'extension' ? {duration: params.request.durationSeconds} : {}),
      ...(params.request.mode !== 'extension' ? {aspect_ratio: params.request.aspectRatio} : {}),
      ...(params.request.mode !== 'extension' ? {resolution: params.request.resolution} : {}),
    };

    if (params.request.image) {
      body.image = {url: await toDataUri(params.request.image)};
    }

    if (params.request.references.length > 0) {
      body.reference_images = await Promise.all(
        params.request.references.map(async (asset) => ({url: await toDataUri(asset)})),
      );
    }

    if (params.request.video) {
      body.video = {url: await toDataUri(params.request.video)};
      body.duration = params.request.durationSeconds;
    }

    const start = await parseJsonResponse<XaiVideoStartResponse>(
      await fetch(`${XAI_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );

    if (!start.request_id) {
      throw new Error('xAI video generation did not return a request_id.');
    }

    const expiresAt = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    while (Date.now() < expiresAt) {
      await sleep(VIDEO_POLL_INTERVAL_MS);
      const result = await parseJsonResponse<XaiVideoPollResponse>(
        await fetch(`${XAI_BASE_URL}/v1/videos/${start.request_id}`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }),
      );

      if (result.status === 'done') {
        if (!result.video?.url) {
          throw new Error('xAI video generation completed without a video URL.');
        }

        params.onProgress?.(`Downloading xAI video to ${params.outputPath}`);
        const mimeType = await downloadUrlToFile(result.video.url, params.outputPath);
        return {
          operationName: start.request_id,
          mimeType,
        };
      }

      if (result.status === 'failed' || result.status === 'expired') {
        throw new Error(`xAI video generation failed: ${getVideoFailureMessage(result)}`);
      }

      params.onProgress?.(
        typeof result.progress === 'number'
          ? `Waiting for xAI video generation (${result.progress}%)`
          : 'Waiting for xAI video generation',
      );
    }

    throw new Error('xAI video generation timed out after 10 minutes.');
  }
}

export const xaiProvider: GenerationProvider = {
  id: 'xai',
  label: 'xAI',
  envVar: 'XAI_API_KEY',
  defaultImageModel: 'imagine',
  defaultVideoModel: 'imagine',
  resolveImageModel(input) {
    return resolveImageModelChoice('xai', input);
  },
  resolveVideoModel(input) {
    return resolveVideoModelChoice('xai', input);
  },
  validateImageRequest(request: ImageCreateRequest) {
    if (request.personGeneration) {
      throw new Error('xAI image generation does not support `--person-generation`.');
    }

    if (request.inputSources.flatMap((source) => source.assets).length > 5) {
      throw new Error('xAI image editing supports at most 5 input images.');
    }

    normalizeXaiImageResolution(request.imageSize);
  },
  validateVideoRequest(request: VideoCreateRequest) {
    if (request.lastFrame) {
      throw new Error('xAI video generation does not support `--last-frame` interpolation.');
    }

    if (request.personGeneration) {
      throw new Error('xAI video generation does not support `--person-generation`.');
    }

    if (request.negativePrompt) {
      throw new Error('xAI video generation does not support `--negative-prompt`.');
    }

    if (typeof request.seed === 'number') {
      throw new Error('xAI video generation does not support `--seed`.');
    }

    if (request.references.length > 7) {
      throw new Error('xAI video generation supports at most 7 reference images.');
    }

    if (!['480p', '720p'].includes(request.resolution)) {
      throw new Error('xAI video resolution must be 480p or 720p.');
    }

    if (!['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].includes(request.aspectRatio)) {
      throw new Error('xAI video aspect ratio must be one of 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, or 2:3.');
    }

    if (request.mode === 'reference' && request.durationSeconds > 10) {
      throw new Error('xAI reference-to-video supports a maximum duration of 10 seconds.');
    }

    if (request.mode !== 'extension' && request.durationSeconds > 15) {
      throw new Error('xAI video generation supports a maximum duration of 15 seconds.');
    }

    if (request.mode === 'extension' && (request.durationSeconds < 2 || request.durationSeconds > 10)) {
      throw new Error('xAI video extension duration must be between 2 and 10 seconds.');
    }
  },
  createClient(apiKey: string) {
    return new XaiGenerationClient(apiKey);
  },
  getAgentHelp() {
    return [
      'Provider: xai',
      'Use for xAI Grok Imagine image and video generation.',
      'API key: XAI_API_KEY or `peek auth --provider xai`.',
      'Image model alias: imagine -> grok-imagine-image.',
      'Image options: `--count` up to 10, `--input` up to 5 images for edits, `--aspect-ratio`, `--size 1k|2k`.',
      'Video model alias: imagine -> grok-imagine-video.',
      'Video modes: prompt, image-to-video with `--image`, reference-to-video with repeated `--reference`, extension with `--video`.',
      'Video limits: duration 1-15 seconds, reference duration max 10 seconds, extension duration 2-10 seconds, resolution 480p or 720p.',
    ].join('\n');
  },
};
