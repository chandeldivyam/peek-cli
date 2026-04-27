import {readFile, writeFile} from 'node:fs/promises';

import {
  resolveImageModelChoice,
  resolveVideoModelChoice,
} from '../generation.js';
import type {ImageCreateRequest, VideoCreateRequest} from '../generation.js';
import type {ResolvedAsset} from '../types.js';
import type {
  GeneratedBinaryOutput,
  GeneratedVideoOutput,
  GenerationProvider,
  GenerationProviderClient,
  ProgressReporter,
} from './types.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai';
const OPENROUTER_API_BASE_URL = `${OPENROUTER_BASE_URL}/api/v1`;
const VIDEO_POLL_INTERVAL_MS = 30_000;
const VIDEO_POLL_TIMEOUT_MS = 15 * 60_000;

const SEEDREAM_IMAGE_MODEL = 'bytedance-seed/seedream-4.5';
const seedreamAspectRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const seedreamImageSizes = ['1K', '2K', '4K'];
const seedanceAspectRatios = ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'];
const seedanceModels = new Set(['bytedance/seedance-2.0', 'bytedance/seedance-2.0-fast']);

interface OpenRouterVideoJob {
  id?: string;
  polling_url?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired' | string;
  error?: string | {message?: string; code?: string};
  generation_id?: string;
  unsigned_urls?: string[];
  usage?: Record<string, unknown>;
}

interface OpenRouterImageUrl {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

interface OpenRouterFrameImage extends OpenRouterImageUrl {
  frame_type: 'first_frame' | 'last_frame';
}

interface OpenRouterChatImage {
  image_url?: {
    url?: string;
  };
  imageUrl?: {
    url?: string;
  };
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      images?: OpenRouterChatImage[];
    };
  }>;
  usage?: unknown;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

async function toDataUri(asset: ResolvedAsset): Promise<string> {
  const bytes = await readFile(asset.absolutePath);
  return `data:${asset.mimeType};base64,${bytes.toString('base64')}`;
}

function getDownloadedMimeType(response: Response, fallback: string): string {
  return response.headers.get('content-type')?.split(';')[0]?.trim() || fallback;
}

function detectImageMimeType(bytes: Buffer, fallback: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return fallback;
}

function resolvePollingUrl(job: OpenRouterVideoJob): string {
  if (job.polling_url) {
    return new URL(job.polling_url, OPENROUTER_BASE_URL).toString();
  }

  if (job.id) {
    return `${OPENROUTER_API_BASE_URL}/videos/${job.id}`;
  }

  throw new Error('OpenRouter video generation did not return an id or polling_url.');
}

function isOpenRouterUrl(url: string): boolean {
  return new URL(url).origin === OPENROUTER_BASE_URL;
}

async function downloadUrlToFile(url: string, outputPath: string, apiKey: string): Promise<string> {
  const response = await fetch(url, {
    ...(isOpenRouterUrl(url)
      ? {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        }
      : {}),
  });

  if (!response.ok) {
    throw new Error(`Failed to download OpenRouter video (${response.status}): ${await response.text()}`);
  }

  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return getDownloadedMimeType(response, 'video/mp4');
}

async function downloadImageUrl(url: string, apiKey: string): Promise<{
  bytes: Buffer;
  mimeType: string;
}> {
  const response = await fetch(url, {
    ...(isOpenRouterUrl(url)
      ? {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        }
      : {}),
  });

  if (!response.ok) {
    throw new Error(`Failed to download OpenRouter image (${response.status}): ${await response.text()}`);
  }

  const fallbackMimeType = getDownloadedMimeType(response, 'image/png');
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    mimeType: detectImageMimeType(bytes, fallbackMimeType),
  };
}

function getVideoFailureMessage(payload: OpenRouterVideoJob): string {
  if (typeof payload.error === 'string') {
    return payload.error;
  }

  return payload.error?.message ?? payload.error?.code ?? `status ${payload.status ?? 'unknown'}`;
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function assertOneOf(label: string, value: string | number, allowed: readonly (string | number)[]): void {
  if (!allowed.includes(value)) {
    throw new Error(`OpenRouter ${label} must be one of ${allowed.join(', ')}.`);
  }
}

function normalizeSeedreamImageSize(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  assertOneOf('Seedream image size', normalized, seedreamImageSizes);
  return normalized;
}

function validateSeedreamImageRequest(request: ImageCreateRequest): void {
  if (request.modelChoice.model !== SEEDREAM_IMAGE_MODEL) {
    throw new Error(`OpenRouter image generation currently supports only ${SEEDREAM_IMAGE_MODEL}.`);
  }

  if (request.personGeneration) {
    throw new Error('OpenRouter Seedream image generation does not support `--person-generation`.');
  }

  if (
    request.quality ||
    request.outputFormat ||
    request.background ||
    typeof request.outputCompression === 'number' ||
    request.moderation
  ) {
    throw new Error('OpenRouter Seedream image generation does not support OpenAI output controls.');
  }

  if (request.aspectRatio) {
    assertOneOf('Seedream aspect ratio', request.aspectRatio, seedreamAspectRatios);
  }

  normalizeSeedreamImageSize(request.imageSize);
}

function validateSeedanceRequest(request: VideoCreateRequest): void {
  if (request.mode === 'extension') {
    throw new Error('OpenRouter video generation does not support `--video` extension yet.');
  }

  if (request.personGeneration) {
    throw new Error('OpenRouter video generation does not support `--person-generation`.');
  }

  if (request.negativePrompt) {
    throw new Error(`Model ${request.modelChoice.model} does not support \`--negative-prompt\` through OpenRouter.`);
  }

  if (!isIntegerInRange(request.durationSeconds, 4, 15)) {
    throw new Error('OpenRouter Seedance duration must be an integer between 4 and 15 seconds.');
  }

  const resolutions = request.modelChoice.model === 'bytedance/seedance-2.0-fast'
    ? ['480p', '720p']
    : ['480p', '720p', '1080p'];
  assertOneOf('Seedance resolution', request.resolution, resolutions);
  assertOneOf('Seedance aspect ratio', request.aspectRatio, seedanceAspectRatios);
}

function validateKlingRequest(request: VideoCreateRequest): void {
  if (request.mode === 'extension') {
    throw new Error('OpenRouter video generation does not support `--video` extension yet.');
  }

  if (request.references.length > 0) {
    throw new Error('OpenRouter Kling Video O1 does not support `--reference` images.');
  }

  if (request.personGeneration) {
    throw new Error('OpenRouter Kling Video O1 does not support `--person-generation`.');
  }

  if (typeof request.seed === 'number') {
    throw new Error('OpenRouter Kling Video O1 does not support `--seed`.');
  }

  assertOneOf('Kling duration', request.durationSeconds, [5, 10]);
  assertOneOf('Kling resolution', request.resolution, ['720p']);
  assertOneOf('Kling aspect ratio', request.aspectRatio, ['16:9', '9:16', '1:1']);
}

function toImageUrl(asset: ResolvedAsset): Promise<OpenRouterImageUrl> {
  return toDataUri(asset).then((url) => ({
    type: 'image_url' as const,
    image_url: {url},
  }));
}

export async function buildOpenRouterImageRequestBody(request: ImageCreateRequest): Promise<Record<string, unknown>> {
  const content: unknown[] = [
    {
      type: 'text',
      text: request.prompt,
    },
    ...(await Promise.all(request.inputSources.flatMap((source) => source.assets).map((asset) => toImageUrl(asset)))),
  ];
  const imageConfig: Record<string, string> = {};
  if (request.aspectRatio) {
    imageConfig.aspect_ratio = request.aspectRatio;
  }

  const imageSize = normalizeSeedreamImageSize(request.imageSize);
  if (imageSize) {
    imageConfig.image_size = imageSize;
  }

  return {
    model: request.modelChoice.model,
    messages: [
      {
        role: 'user',
        content,
      },
    ],
    modalities: ['image'],
    stream: false,
    ...(Object.keys(imageConfig).length > 0 ? {image_config: imageConfig} : {}),
  };
}

export async function buildOpenRouterVideoRequestBody(request: VideoCreateRequest): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: request.modelChoice.model,
    prompt: request.prompt,
    duration: request.durationSeconds,
    resolution: request.resolution,
    aspect_ratio: request.aspectRatio,
  };

  if (typeof request.seed === 'number') {
    body.seed = request.seed;
  }

  if (request.negativePrompt) {
    body.negative_prompt = request.negativePrompt;
  }

  const frameImages: OpenRouterFrameImage[] = [];
  if (request.image) {
    frameImages.push({
      ...(await toImageUrl(request.image)),
      frame_type: 'first_frame',
    });
  }

  if (request.lastFrame) {
    frameImages.push({
      ...(await toImageUrl(request.lastFrame)),
      frame_type: 'last_frame',
    });
  }

  if (frameImages.length > 0) {
    body.frame_images = frameImages;
  }

  if (request.references.length > 0) {
    body.input_references = await Promise.all(request.references.map((asset) => toImageUrl(asset)));
  }

  return body;
}

function toUsage(usage: unknown): GeneratedBinaryOutput['usage'] | GeneratedVideoOutput['usage'] | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const usageRecord = usage as Record<string, unknown>;

  return {
    ...(typeof usageRecord.cost === 'number' ? {cost: usageRecord.cost} : {}),
    ...(typeof usageRecord.is_byok === 'boolean' ? {isByok: usageRecord.is_byok} : {}),
    raw: usage,
  };
}

function decodeImageDataUrl(url: string): {
  bytes: Buffer;
  mimeType: string;
} {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) {
    throw new Error('OpenRouter returned an unsupported image data URL.');
  }

  const fallbackMimeType = match[1]!;
  const bytes = Buffer.from(match[2]!, 'base64');
  return {
    bytes,
    mimeType: detectImageMimeType(bytes, fallbackMimeType),
  };
}

async function resolveGeneratedImage(url: string, apiKey: string): Promise<{
  bytes: Buffer;
  mimeType: string;
}> {
  if (url.startsWith('data:')) {
    return decodeImageDataUrl(url);
  }

  return await downloadImageUrl(url, apiKey);
}

class OpenRouterGenerationClient implements GenerationProviderClient {
  constructor(private readonly apiKey: string) {}

  async generateImages(params: {
    request: ImageCreateRequest;
    onProgress?: ProgressReporter;
  }): Promise<GeneratedBinaryOutput[]> {
    const outputs: GeneratedBinaryOutput[] = [];

    for (let index = 0; index < params.request.count; index += 1) {
      params.onProgress?.(
        params.request.count === 1
          ? `Requesting OpenRouter image generation with ${params.request.modelChoice.model}`
          : `Requesting OpenRouter image ${index + 1}/${params.request.count} with ${params.request.modelChoice.model}`,
      );
      const response = await parseJsonResponse<OpenRouterChatResponse>(
        await fetch(`${OPENROUTER_API_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'X-OpenRouter-Title': 'peek',
          },
          body: JSON.stringify(await buildOpenRouterImageRequestBody(params.request)),
        }),
      );
      const usage = toUsage(response.usage);
      const images = response.choices?.flatMap((choice) => choice.message?.images ?? []) ?? [];

      for (const image of images) {
        const url = image.image_url?.url ?? image.imageUrl?.url;
        if (!url) {
          throw new Error('OpenRouter returned an image item without an image URL.');
        }

        outputs.push({
          ...(await resolveGeneratedImage(url, this.apiKey)),
          kind: 'image',
          ...(usage ? {usage} : {}),
        });
      }
    }

    if (outputs.length === 0) {
      throw new Error('OpenRouter image generation returned no images.');
    }

    return outputs;
  }

  async generateVideo(params: {
    request: VideoCreateRequest;
    outputPath: string;
    onProgress?: ProgressReporter;
  }): Promise<GeneratedVideoOutput> {
    params.onProgress?.(`Starting OpenRouter video generation with ${params.request.modelChoice.model}`);
    const start = await parseJsonResponse<OpenRouterVideoJob>(
      await fetch(`${OPENROUTER_API_BASE_URL}/videos`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-OpenRouter-Title': 'peek',
        },
        body: JSON.stringify(await buildOpenRouterVideoRequestBody(params.request)),
      }),
    );

    const pollingUrl = resolvePollingUrl(start);
    const expiresAt = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    while (Date.now() < expiresAt) {
      await sleep(VIDEO_POLL_INTERVAL_MS);
      const result = await parseJsonResponse<OpenRouterVideoJob>(
        await fetch(pollingUrl, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }),
      );

      if (result.status === 'completed') {
        const videoUrl = result.unsigned_urls?.[0];
        if (!videoUrl) {
          throw new Error('OpenRouter video generation completed without an unsigned video URL.');
        }

        params.onProgress?.(`Downloading OpenRouter video to ${params.outputPath}`);
        const mimeType = await downloadUrlToFile(videoUrl, params.outputPath, this.apiKey);
        const operationName = result.generation_id ?? result.id ?? start.id;
        const usage = toUsage(result.usage);
        return {
          mimeType,
          ...(operationName ? {operationName} : {}),
          ...(usage ? {usage} : {}),
        };
      }

      if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'expired') {
        throw new Error(`OpenRouter video generation failed: ${getVideoFailureMessage(result)}`);
      }

      params.onProgress?.(`Waiting for OpenRouter video generation (${result.status ?? 'pending'})`);
    }

    throw new Error('OpenRouter video generation timed out after 15 minutes.');
  }
}

export const openRouterProvider: GenerationProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  envVar: 'OPENROUTER_API_KEY',
  defaultImageModel: 'seedream',
  defaultVideoModel: 'bytedance/seedance-2.0-fast',
  resolveImageModel(input) {
    return resolveImageModelChoice('openrouter', input);
  },
  resolveVideoModel(input) {
    return resolveVideoModelChoice('openrouter', input);
  },
  validateImageRequest(request: ImageCreateRequest) {
    validateSeedreamImageRequest(request);
  },
  validateVideoRequest(request: VideoCreateRequest) {
    if (request.modelChoice.model === 'bytedance-seed/seed-2.0-mini') {
      throw new Error('bytedance-seed/seed-2.0-mini is not an OpenRouter video-generation model.');
    }

    if (seedanceModels.has(request.modelChoice.model)) {
      validateSeedanceRequest(request);
      return;
    }

    if (request.modelChoice.model === 'kwaivgi/kling-video-o1') {
      validateKlingRequest(request);
      return;
    }

    throw new Error(
      `Unsupported OpenRouter video-generation model "${request.modelChoice.model}". Use bytedance/seedance-2.0, bytedance/seedance-2.0-fast, or kwaivgi/kling-video-o1.`,
    );
  },
  createClient(apiKey: string) {
    return new OpenRouterGenerationClient(apiKey);
  },
  getAgentHelp() {
    return [
      'Provider: openrouter',
      'Use for OpenRouter ByteDance Seedream image generation and supported video-generation models.',
      'API key: OPENROUTER_API_KEY or `peek auth --provider openrouter`.',
      'Image aliases: seedream, seedream-4.5 -> bytedance-seed/seedream-4.5.',
      'Image options: `--input` for reference/edit images, `--count`, `--aspect-ratio`, `--size 1K|2K|4K`.',
      'Video models use raw OpenRouter slugs: bytedance/seedance-2.0, bytedance/seedance-2.0-fast, kwaivgi/kling-video-o1.',
      'Examples:',
      '- peek create image --provider openrouter --model seedream "A clean product poster"',
      '- peek create image --provider openrouter --input ./ref.jpg --aspect-ratio 16:9 "Turn this into a polished launch graphic"',
      '- peek create video --provider openrouter --model bytedance/seedance-2.0-fast --duration 4 --resolution 480p "A kinetic product reveal"',
      '- peek create video --provider openrouter --model bytedance/seedance-2.0 --image ./start.png --last-frame ./end.png "Move from first frame to final frame"',
      '- peek create video --provider openrouter --model kwaivgi/kling-video-o1 --duration 5 --negative-prompt "blurry" "A cinematic street scene"',
    ].join('\n');
  },
};
