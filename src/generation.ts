import {randomUUID} from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import type {
  GeneratedOutputAsset,
  GenerationKind,
  GenerationMode,
  GenerationProviderId,
  MediaKind,
  ResolvedAsset,
  SourceDescriptor,
} from './types.js';

export interface ModelChoice {
  alias?: string;
  model: string;
}

interface ImageModelProfile extends ModelChoice {
  defaultImageSize?: string;
}

interface VideoModelProfile extends ModelChoice {
  supportsReferenceImages: boolean;
  supportsExtension: boolean;
  supports4k: boolean;
  supports1080p: boolean;
  supportsPortrait1080p: boolean;
}

const imageModelAliases = new Map<string, ImageModelProfile>([
  ['gemini:flash', {alias: 'flash', model: 'gemini-3.1-flash-image-preview', defaultImageSize: '1K'}],
  ['gemini:pro', {alias: 'pro', model: 'gemini-3-pro-image-preview', defaultImageSize: '2K'}],
  ['xai:imagine', {alias: 'imagine', model: 'grok-imagine-image'}],
]);

const videoModelAliases = new Map<string, VideoModelProfile>([
  [
    'gemini:fast',
    {
      alias: 'fast',
      model: 'veo-3.1-fast-generate-preview',
      supportsReferenceImages: true,
      supportsExtension: true,
      supports4k: true,
      supports1080p: true,
      supportsPortrait1080p: true,
    },
  ],
  [
    'gemini:quality',
    {
      alias: 'quality',
      model: 'veo-3.1-generate-preview',
      supportsReferenceImages: true,
      supportsExtension: true,
      supports4k: true,
      supports1080p: true,
      supportsPortrait1080p: true,
    },
  ],
  [
    'gemini:lite',
    {
      alias: 'lite',
      model: 'veo-3.1-lite-generate-preview',
      supportsReferenceImages: false,
      supportsExtension: false,
      supports4k: false,
      supports1080p: true,
      supportsPortrait1080p: false,
    },
  ],
  [
    'xai:imagine',
    {
      alias: 'imagine',
      model: 'grok-imagine-video',
      supportsReferenceImages: true,
      supportsExtension: true,
      supports4k: false,
      supports1080p: false,
      supportsPortrait1080p: false,
    },
  ],
]);

function isGenerationProviderId(value: string): value is GenerationProviderId {
  return value === 'gemini' || value === 'xai' || value === 'openrouter';
}

export interface ResolvedGenerationSource {
  rawInput: string;
  source: SourceDescriptor;
  assets: ResolvedAsset[];
}

export interface ImageCreateRequest {
  kind: 'image';
  provider: GenerationProviderId;
  modelChoice: ImageModelProfile;
  prompt: string;
  count: number;
  aspectRatio?: string;
  imageSize?: string;
  personGeneration?: 'allow_all' | 'allow_adult' | 'allow_none';
  inputSources: ResolvedGenerationSource[];
  outputPath?: string;
  json: boolean;
}

export interface VideoCreateRequest {
  kind: 'video';
  provider: GenerationProviderId;
  modelChoice: VideoModelProfile;
  prompt: string;
  mode: GenerationMode;
  aspectRatio: string;
  durationSeconds: number;
  resolution: string;
  personGeneration?: 'allow_all' | 'allow_adult';
  negativePrompt?: string;
  seed?: number;
  image?: ResolvedAsset;
  lastFrame?: ResolvedAsset;
  references: ResolvedAsset[];
  video?: ResolvedAsset;
  inputSources: ResolvedGenerationSource[];
  outputPath?: string;
  json: boolean;
}

export interface PlannedOutputAsset {
  index: number;
  path: string;
  kind: MediaKind;
  mimeType: string;
}

export function resolveImageModelChoice(
  providerOrInput: GenerationProviderId | string = 'gemini',
  input?: string,
): ImageModelProfile {
  const provider: GenerationProviderId =
    isGenerationProviderId(providerOrInput) ? providerOrInput : 'gemini';
  const modelInput =
    isGenerationProviderId(providerOrInput) ? input : providerOrInput;

  if (!modelInput?.trim()) {
    if (provider === 'openrouter') {
      return {model: ''};
    }

    return imageModelAliases.get(`${provider}:imagine`) ?? imageModelAliases.get(`${provider}:flash`)!;
  }

  const normalized = modelInput.trim().toLowerCase();
  return imageModelAliases.get(`${provider}:${normalized}`) ?? {model: modelInput.trim().replace(/^models\//, '')};
}

export function resolveVideoModelChoice(
  providerOrInput: GenerationProviderId | string = 'gemini',
  input?: string,
): VideoModelProfile {
  const provider: GenerationProviderId =
    isGenerationProviderId(providerOrInput) ? providerOrInput : 'gemini';
  const modelInput =
    isGenerationProviderId(providerOrInput) ? input : providerOrInput;

  if (!modelInput?.trim()) {
    if (provider === 'openrouter') {
      return {
        model: 'bytedance/seedance-2.0-fast',
        supportsReferenceImages: true,
        supportsExtension: false,
        supports4k: false,
        supports1080p: false,
        supportsPortrait1080p: false,
      };
    }

    return videoModelAliases.get(`${provider}:imagine`) ?? videoModelAliases.get(`${provider}:fast`)!;
  }

  const normalized = modelInput.trim().toLowerCase();
  return (
    videoModelAliases.get(`${provider}:${normalized}`) ?? {
      model: modelInput.trim().replace(/^models\//, ''),
      supportsReferenceImages: true,
      supportsExtension: true,
      supports4k: true,
      supports1080p: true,
      supportsPortrait1080p: true,
    }
  );
}

export function ensureImageSources(inputSources: ResolvedGenerationSource[]): void {
  for (const inputSource of inputSources) {
    if (inputSource.assets.length === 0) {
      throw new Error(`No image assets were resolved from ${inputSource.rawInput}.`);
    }

    const nonImages = inputSource.assets.filter((asset) => asset.kind !== 'image');
    if (nonImages.length > 0) {
      throw new Error(
        `Generation inputs for images must resolve only image assets. ${inputSource.rawInput} includes ${nonImages[0]?.kind ?? 'unsupported'} media.`,
      );
    }
  }
}

export function ensureSingleAsset(
  rawInput: string,
  inputSource: ResolvedGenerationSource,
  expectedKind: MediaKind,
): ResolvedAsset {
  if (inputSource.assets.length !== 1) {
    throw new Error(`${rawInput} resolved to ${inputSource.assets.length} assets. Pass a single ${expectedKind} asset here.`);
  }

  const asset = inputSource.assets[0];
  if (!asset || asset.kind !== expectedKind) {
    throw new Error(`${rawInput} must resolve to a single ${expectedKind} asset.`);
  }

  return asset;
}

export function buildImageCreateRequest(params: {
  provider?: GenerationProviderId;
  model?: string;
  prompt: string;
  count?: number;
  aspectRatio?: string;
  imageSize?: string;
  personGeneration?: 'allow_all' | 'allow_adult' | 'allow_none';
  inputSources: ResolvedGenerationSource[];
  outputPath?: string;
  json?: boolean;
}): ImageCreateRequest {
  const provider = params.provider ?? 'gemini';
  const count = params.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error('Image generation count must be an integer between 1 and 10.');
  }

  if (!params.prompt.trim()) {
    throw new Error('A generation prompt is required.');
  }

  ensureImageSources(params.inputSources);
  const modelChoice = resolveImageModelChoice(provider, params.model);

  return {
    kind: 'image',
    provider,
    modelChoice,
    prompt: params.prompt.trim(),
    count,
    ...(params.aspectRatio ? {aspectRatio: params.aspectRatio} : {}),
    ...(params.imageSize ? {imageSize: params.imageSize} : modelChoice.defaultImageSize ? {imageSize: modelChoice.defaultImageSize} : {}),
    ...(params.personGeneration ? {personGeneration: params.personGeneration} : {}),
    inputSources: params.inputSources,
    ...(params.outputPath ? {outputPath: params.outputPath} : {}),
    json: params.json ?? false,
  };
}

function inferVideoMode(params: {
  hasImage: boolean;
  hasLastFrame: boolean;
  hasReferences: boolean;
  hasVideo: boolean;
}): GenerationMode {
  if (params.hasVideo) {
    return 'extension';
  }

  if (params.hasReferences) {
    return 'reference';
  }

  if (params.hasImage && params.hasLastFrame) {
    return 'interpolation';
  }

  if (params.hasImage) {
    return 'image-to-video';
  }

  return 'prompt';
}

function getDefaultVideoDuration(provider: GenerationProviderId, model: string): number {
  if (provider === 'openrouter' && model === 'kwaivgi/kling-video-o1') {
    return 5;
  }

  return 4;
}

export function buildVideoCreateRequest(params: {
  provider?: GenerationProviderId;
  model?: string;
  prompt: string;
  imageSource?: ResolvedGenerationSource;
  lastFrameSource?: ResolvedGenerationSource;
  referenceSources: ResolvedGenerationSource[];
  videoSource?: ResolvedGenerationSource;
  aspectRatio?: string;
  durationSeconds?: number;
  resolution?: string;
  personGeneration?: 'allow_all' | 'allow_adult';
  negativePrompt?: string;
  seed?: number;
  outputPath?: string;
  json?: boolean;
}): VideoCreateRequest {
  const provider = params.provider ?? 'gemini';
  const hasImage = Boolean(params.imageSource);
  const hasLastFrame = Boolean(params.lastFrameSource);
  const hasReferences = params.referenceSources.length > 0;
  const hasVideo = Boolean(params.videoSource);

  if (hasLastFrame && !hasImage) {
    throw new Error('`--last-frame` requires `--image`.');
  }

  if (hasVideo && (hasImage || hasLastFrame || hasReferences)) {
    throw new Error('`--video` cannot be combined with `--image`, `--last-frame`, or `--reference`.');
  }

  if (hasReferences && (hasImage || hasLastFrame)) {
    throw new Error('`--reference` cannot be combined with `--image` or `--last-frame`.');
  }

  const referenceAssets = params.referenceSources.map((source) => ensureSingleAsset(source.rawInput, source, 'image'));

  const image = params.imageSource
    ? ensureSingleAsset(params.imageSource.rawInput, params.imageSource, 'image')
    : undefined;
  const lastFrame = params.lastFrameSource
    ? ensureSingleAsset(params.lastFrameSource.rawInput, params.lastFrameSource, 'image')
    : undefined;
  const video = params.videoSource
    ? ensureSingleAsset(params.videoSource.rawInput, params.videoSource, 'video')
    : undefined;

  const modelChoice = resolveVideoModelChoice(provider, params.model);
  const mode = inferVideoMode({
    hasImage,
    hasLastFrame,
    hasReferences,
    hasVideo,
  });
  const aspectRatio = params.aspectRatio ?? '16:9';
  const durationSeconds = params.durationSeconds ?? getDefaultVideoDuration(provider, modelChoice.model);
  const resolution = params.resolution ?? '720p';
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1) {
    throw new Error('Video duration must be a positive integer number of seconds.');
  }

  if (!params.prompt.trim()) {
    throw new Error('A generation prompt is required.');
  }

  const inputSources = [
    ...(params.imageSource ? [params.imageSource] : []),
    ...(params.lastFrameSource ? [params.lastFrameSource] : []),
    ...params.referenceSources,
    ...(params.videoSource ? [params.videoSource] : []),
  ];

  return {
    kind: 'video',
    provider,
    modelChoice,
    prompt: params.prompt.trim(),
    mode,
    aspectRatio,
    durationSeconds,
    resolution,
    ...(params.personGeneration ? {personGeneration: params.personGeneration} : {}),
    ...(params.negativePrompt?.trim()
      ? {negativePrompt: params.negativePrompt.trim()}
      : {}),
    ...(typeof params.seed === 'number' ? {seed: params.seed} : {}),
    ...(image ? {image} : {}),
    ...(lastFrame ? {lastFrame} : {}),
    references: referenceAssets,
    ...(video ? {video} : {}),
    inputSources,
    ...(params.outputPath ? {outputPath: params.outputPath} : {}),
    json: params.json ?? false,
  };
}

function slugify(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'generation';
}

function getDefaultOutputRoot(prompt: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(process.cwd(), 'peek-output', `${timestamp}-${slugify(prompt).slice(0, 48)}`);
}

function inferOutputExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    case 'image/heif':
      return 'heif';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'video/quicktime':
      return 'mov';
    default:
      throw new Error(`Unable to infer a file extension for ${mimeType}.`);
  }
}

export function planOutputAssets(params: {
  kind: GenerationKind;
  count: number;
  mimeTypes: string[];
  outputPath?: string;
  prompt: string;
}): PlannedOutputAsset[] {
  if (params.count < 1 || params.mimeTypes.length !== params.count) {
    throw new Error('Output planning requires a mime type for every generated asset.');
  }

  const resolvedOutputPath = params.outputPath
    ? path.resolve(params.outputPath)
    : getDefaultOutputRoot(params.prompt);

  const hasExplicitExtension = path.extname(resolvedOutputPath).length > 0;
  if (params.count > 1 && hasExplicitExtension) {
    throw new Error('When multiple assets are generated, `--output` must be a directory path.');
  }

  return params.mimeTypes.map((mimeType, index) => {
    const extension = inferOutputExtension(mimeType);
    const targetPath =
      params.count === 1 && hasExplicitExtension
        ? resolvedOutputPath
        : path.join(
            resolvedOutputPath,
            `${params.kind}-${String(index + 1).padStart(3, '0')}.${extension}`,
          );

    return {
      index,
      path: targetPath,
      kind: params.kind,
      mimeType,
    };
  });
}

export function buildGenerationId(): string {
  return randomUUID();
}

export function toGeneratedOutputAssets(params: {
  createdAt: string;
  outputs: Array<{
    path: string;
    hash: string;
    sizeBytes: number;
    mimeType: string;
    kind: MediaKind;
  }>;
}): GeneratedOutputAsset[] {
  return params.outputs.map((output, index) => ({
    index,
    kind: output.kind,
    path: output.path,
    hash: output.hash,
    sizeBytes: output.sizeBytes,
    mimeType: output.mimeType,
    createdAt: params.createdAt,
  }));
}
