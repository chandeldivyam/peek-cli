import path from 'node:path';
import {readFile} from 'node:fs/promises';

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
  GeneratedVideoOutput,
  ProgressReporter,
} from './types.js';

const OPENAI_BASE_URL = 'https://api.openai.com';
const OPENAI_IMAGE_MODEL = 'gpt-image-2';
const OPENAI_DEFAULT_SIZE = '1024x1024';
const OPENAI_ASPECT_RATIO_SIZES: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '16:9': '1536x864',
  '9:16': '864x1536',
};

interface OpenAiImageResponse {
  data?: Array<{
    b64_json?: string;
  }>;
  usage?: unknown;
}

type OpenAiImageRequestBody = Record<string, string | number>;

function parseJsonResponse<T>(response: Response): Promise<T> {
  return response.text().then((text) => {
    if (!response.ok) {
      throw new Error(`OpenAI request failed (${response.status}): ${text}`);
    }

    return (text ? JSON.parse(text) : {}) as T;
  });
}

function ensureAllowedValue(
  name: string,
  value: string | undefined,
  allowed: readonly string[],
): void {
  if (value && !allowed.includes(value)) {
    throw new Error(`OpenAI ${name} must be one of ${allowed.join(', ')}.`);
  }
}

function normalizeOpenAiImageSize(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto') {
    return 'auto';
  }

  if (normalized === '1k') {
    return OPENAI_DEFAULT_SIZE;
  }

  if (normalized === '2k') {
    return '2048x2048';
  }

  const match = /^(\d+)x(\d+)$/.exec(normalized);
  if (!match) {
    throw new Error('OpenAI image size must be `auto`, `1k`, `2k`, or dimensions like `1024x1024`.');
  }

  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;

  if (longEdge > 3840) {
    throw new Error('OpenAI image size maximum edge length must be 3840px or less.');
  }

  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error('OpenAI image size width and height must both be multiples of 16px.');
  }

  if (longEdge / shortEdge > 3) {
    throw new Error('OpenAI image size long-edge to short-edge ratio must not exceed 3:1.');
  }

  if (pixels < 655_360 || pixels > 8_294_400) {
    throw new Error('OpenAI image size total pixels must be between 655,360 and 8,294,400.');
  }

  return `${width}x${height}`;
}

function getOpenAiImageSize(request: ImageCreateRequest): string {
  if (request.aspectRatio) {
    const size = OPENAI_ASPECT_RATIO_SIZES[request.aspectRatio];
    if (!size) {
      throw new Error('OpenAI image aspect ratio must be one of 1:1, 3:2, 2:3, 16:9, or 9:16.');
    }
    return size;
  }

  return normalizeOpenAiImageSize(request.imageSize) ?? OPENAI_DEFAULT_SIZE;
}

function getOpenAiOutputMimeType(format?: string): string {
  if (format === 'jpeg') {
    return 'image/jpeg';
  }

  if (format === 'webp') {
    return 'image/webp';
  }

  return 'image/png';
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

function addOpenAiImageOptions(
  target: OpenAiImageRequestBody | FormData,
  request: ImageCreateRequest,
): void {
  const entries: Array<[string, string | number]> = [
    ['model', request.modelChoice.model],
    ['prompt', request.prompt],
    ['n', request.count],
    ['size', getOpenAiImageSize(request)],
  ];

  if (request.quality) {
    entries.push(['quality', request.quality]);
  }

  if (request.outputFormat) {
    entries.push(['output_format', request.outputFormat]);
  }

  if (request.background) {
    entries.push(['background', request.background]);
  }

  if (typeof request.outputCompression === 'number') {
    entries.push(['output_compression', request.outputCompression]);
  }

  if (request.moderation) {
    entries.push(['moderation', request.moderation]);
  }

  for (const [key, value] of entries) {
    if (target instanceof FormData) {
      target.append(key, String(value));
    } else {
      target[key] = value;
    }
  }
}

async function appendImageFile(form: FormData, asset: ResolvedAsset): Promise<void> {
  const bytes = await readFile(asset.absolutePath);
  const blob = new Blob([new Uint8Array(bytes)], {type: asset.mimeType});
  form.append('image[]', blob, path.basename(asset.absolutePath));
}

function toOpenAiUsage(usage: unknown): GeneratedBinaryOutput['usage'] | undefined {
  if (!usage) {
    return undefined;
  }

  return {raw: usage};
}

export function buildOpenAiImageGenerationBody(request: ImageCreateRequest): OpenAiImageRequestBody {
  const body: OpenAiImageRequestBody = {};
  addOpenAiImageOptions(body, request);
  return body;
}

export async function buildOpenAiImageEditFormData(request: ImageCreateRequest): Promise<FormData> {
  const form = new FormData();
  addOpenAiImageOptions(form, request);
  for (const asset of request.inputSources.flatMap((source) => source.assets)) {
    await appendImageFile(form, asset);
  }
  return form;
}

function validateOpenAiImageRequest(request: ImageCreateRequest): void {
  if (request.modelChoice.model !== OPENAI_IMAGE_MODEL) {
    throw new Error(`OpenAI image generation currently supports only ${OPENAI_IMAGE_MODEL}.`);
  }

  if (request.personGeneration) {
    throw new Error('OpenAI image generation does not support `--person-generation`.');
  }

  if (request.aspectRatio && request.imageSize) {
    throw new Error('OpenAI image generation does not support combining `--aspect-ratio` and `--size`.');
  }

  ensureAllowedValue('quality', request.quality, ['low', 'medium', 'high', 'auto']);
  ensureAllowedValue('output format', request.outputFormat, ['png', 'jpeg', 'webp']);
  ensureAllowedValue('background', request.background, ['auto', 'opaque', 'transparent']);
  ensureAllowedValue('moderation', request.moderation, ['auto', 'low']);

  if (request.background === 'transparent') {
    throw new Error('gpt-image-2 does not support transparent backgrounds. Use `--background auto` or `--background opaque`.');
  }

  if (typeof request.outputCompression === 'number') {
    if (!Number.isInteger(request.outputCompression) || request.outputCompression < 0 || request.outputCompression > 100) {
      throw new Error('OpenAI image compression must be an integer between 0 and 100.');
    }

    if (request.outputFormat !== 'jpeg' && request.outputFormat !== 'webp') {
      throw new Error('OpenAI image compression requires `--output-format jpeg` or `--output-format webp`.');
    }
  }

  normalizeOpenAiImageSize(request.imageSize);
  if (request.aspectRatio) {
    getOpenAiImageSize(request);
  }
}

class OpenAiGenerationClient implements GenerationProviderClient {
  constructor(private readonly apiKey: string) {}

  async generateImages(params: {
    request: ImageCreateRequest;
    onProgress?: ProgressReporter;
  }): Promise<GeneratedBinaryOutput[]> {
    const inputAssets = params.request.inputSources.flatMap((inputSource) => inputSource.assets);
    const hasInputs = inputAssets.length > 0;
    const endpoint = hasInputs ? '/v1/images/edits' : '/v1/images/generations';

    params.onProgress?.(`Requesting OpenAI image generation with ${params.request.modelChoice.model}`);
    const response = await parseJsonResponse<OpenAiImageResponse>(
      await fetch(`${OPENAI_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(hasInputs ? {} : {'Content-Type': 'application/json'}),
        },
        body: hasInputs
          ? await buildOpenAiImageEditFormData(params.request)
          : JSON.stringify(buildOpenAiImageGenerationBody(params.request)),
      }),
    );

    const usage = toOpenAiUsage(response.usage);
    const outputs = (response.data ?? []).map((image) => {
      if (!image.b64_json) {
        throw new Error('OpenAI returned an image item without b64_json.');
      }

      const bytes = Buffer.from(image.b64_json, 'base64');
      return {
        bytes,
        mimeType: detectImageMimeType(bytes, getOpenAiOutputMimeType(params.request.outputFormat)),
        kind: 'image' as const,
        ...(usage ? {usage} : {}),
      };
    });

    if (outputs.length === 0) {
      throw new Error('OpenAI image generation returned no images.');
    }

    return outputs;
  }

  async generateVideo(): Promise<GeneratedVideoOutput> {
    throw new Error('OpenAI video generation is not supported by peek. Use `peek create image --provider openai` with gpt-image-2.');
  }
}

export const openAiProvider: GenerationProvider = {
  id: 'openai',
  label: 'OpenAI',
  envVar: 'OPENAI_API_KEY',
  defaultImageModel: OPENAI_IMAGE_MODEL,
  defaultVideoModel: '',
  resolveImageModel(input) {
    return resolveImageModelChoice('openai', input);
  },
  resolveVideoModel(input) {
    return resolveVideoModelChoice('openai', input);
  },
  validateImageRequest(request: ImageCreateRequest) {
    validateOpenAiImageRequest(request);
  },
  validateVideoRequest() {
    throw new Error('OpenAI video generation is not supported by peek. Use `peek create image --provider openai` with gpt-image-2.');
  },
  createClient(apiKey: string) {
    return new OpenAiGenerationClient(apiKey);
  },
  getAgentHelp() {
    return [
      'Provider: openai',
      'Use for OpenAI GPT Image 2 image generation and image edits only.',
      'API key: OPENAI_API_KEY or `peek auth --provider openai`.',
      'Image model: gpt-image-2. No aliases beyond the raw model name.',
      'Text-to-image: `peek create image --provider openai --model gpt-image-2 "A clean product poster"`.',
      'Image edit/reference: repeat `--input` and Peek sends those images to the OpenAI image edits endpoint.',
      'Output controls: `--quality low|medium|high|auto`, `--output-format png|jpeg|webp`, `--compression 0-100` for jpeg/webp, `--background auto|opaque`, `--moderation auto|low`.',
      'Size controls: use `--size auto`, `--size 1024x1024`, custom dimensions that meet OpenAI constraints, or `--aspect-ratio 1:1|3:2|2:3|16:9|9:16`.',
      'OpenAI video generation is not supported in peek.',
    ].join('\n');
  },
};
