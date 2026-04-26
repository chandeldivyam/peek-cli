import {
  resolveImageModelChoice,
  resolveVideoModelChoice,
} from '../generation.js';
import type {ImageCreateRequest, VideoCreateRequest} from '../generation.js';
import {GeminiService} from '../gemini.js';
import type {GenerationProvider, GenerationProviderClient} from './types.js';

function normalizeGeminiImageSize(value?: string): '1K' | '2K' | '4K' | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toUpperCase();
  if (normalized === '1K' || normalized === '2K' || normalized === '4K') {
    return normalized;
  }

  throw new Error('Gemini image size must be 1K, 2K, or 4K.');
}

function getGeminiPersonGeneration(
  request: VideoCreateRequest,
): 'allow_all' | 'allow_adult' {
  return request.personGeneration ??
    (request.mode === 'prompt' || request.mode === 'extension' ? 'allow_all' : 'allow_adult');
}

function rejectOpenAiImageControls(request: ImageCreateRequest, providerLabel: string): void {
  if (
    request.quality ||
    request.outputFormat ||
    request.background ||
    typeof request.outputCompression === 'number' ||
    request.moderation
  ) {
    throw new Error(`${providerLabel} image generation does not support OpenAI output controls.`);
  }
}

export const geminiProvider: GenerationProvider = {
  id: 'gemini',
  label: 'Google Gemini',
  envVar: 'GEMINI_API_KEY',
  defaultImageModel: 'flash',
  defaultVideoModel: 'fast',
  resolveImageModel(input) {
    return resolveImageModelChoice('gemini', input);
  },
  resolveVideoModel(input) {
    return resolveVideoModelChoice('gemini', input);
  },
  validateImageRequest(request: ImageCreateRequest) {
    rejectOpenAiImageControls(request, 'Gemini');

    if (request.count > 8) {
      throw new Error('Gemini image generation count must be an integer between 1 and 8.');
    }

    normalizeGeminiImageSize(request.imageSize);
  },
  validateVideoRequest(request: VideoCreateRequest) {
    const personGeneration = getGeminiPersonGeneration(request);

    if (request.references.length > 3) {
      throw new Error('Veo supports at most 3 reference images.');
    }

    if (request.mode === 'reference' && !request.modelChoice.supportsReferenceImages) {
      throw new Error(`Model ${request.modelChoice.model} does not support reference images.`);
    }

    if (request.mode === 'extension' && !request.modelChoice.supportsExtension) {
      throw new Error(`Model ${request.modelChoice.model} does not support video extension.`);
    }

    if (request.resolution === '4k' && !request.modelChoice.supports4k) {
      throw new Error(`Model ${request.modelChoice.model} does not support 4k output.`);
    }

    if (request.resolution === '1080p' && !request.modelChoice.supports1080p) {
      throw new Error(`Model ${request.modelChoice.model} does not support 1080p output.`);
    }

    if (
      request.resolution === '1080p' &&
      request.aspectRatio === '9:16' &&
      !request.modelChoice.supportsPortrait1080p
    ) {
      throw new Error(`Model ${request.modelChoice.model} supports 1080p only with 16:9 output.`);
    }

    if (request.mode === 'extension' && request.resolution !== '720p') {
      throw new Error('Video extension only supports 720p output.');
    }

    if (
      (request.mode === 'reference' ||
        request.mode === 'extension' ||
        request.resolution !== '720p') &&
      request.durationSeconds !== 8
    ) {
      throw new Error('Reference images, extension, 1080p, and 4k output require `--duration 8`.');
    }

    if (request.mode === 'prompt' || request.mode === 'extension') {
      if (personGeneration !== 'allow_all') {
        throw new Error('Text-to-video and extension only support `allow_all` for person generation on Veo 3.1.');
      }
    } else if (personGeneration !== 'allow_adult') {
      throw new Error('Image-to-video, interpolation, and reference-image generation only support `allow_adult` on Veo 3.1.');
    }
  },
  createClient(apiKey: string): GenerationProviderClient {
    const gemini = new GeminiService(apiKey);

    return {
      async generateImages({request, onProgress}) {
        const imageSize = request.imageSize
          ? normalizeGeminiImageSize(request.imageSize)
          : undefined;
        return await gemini.generateImages({
          prompt: request.prompt,
          model: request.modelChoice.model,
          count: request.count,
          ...(request.aspectRatio ? {aspectRatio: request.aspectRatio} : {}),
          ...(imageSize ? {imageSize} : {}),
          ...(request.personGeneration ? {personGeneration: request.personGeneration} : {}),
          inputAssets: request.inputSources.flatMap((inputSource) => inputSource.assets),
          ...(onProgress ? {onProgress} : {}),
        });
      },
      async generateVideo({request, outputPath, onProgress}) {
        return await gemini.generateVideo({
          prompt: request.prompt,
          model: request.modelChoice.model,
          aspectRatio: request.aspectRatio as '16:9' | '9:16',
          durationSeconds: request.durationSeconds as 4 | 6 | 8,
          resolution: request.resolution as '720p' | '1080p' | '4k',
          personGeneration: getGeminiPersonGeneration(request),
          ...(request.negativePrompt ? {negativePrompt: request.negativePrompt} : {}),
          ...(typeof request.seed === 'number' ? {seed: request.seed} : {}),
          ...(request.image ? {image: request.image} : {}),
          ...(request.lastFrame ? {lastFrame: request.lastFrame} : {}),
          references: request.references,
          ...(request.video ? {video: request.video} : {}),
          outputPath,
          ...(onProgress ? {onProgress} : {}),
        });
      },
    };
  },
  getAgentHelp() {
    return [
      'Provider: gemini',
      'Use for Gemini image generation and Veo video generation.',
      'API key: GEMINI_API_KEY or `peek auth --provider gemini`.',
      'Image aliases: flash, pro. Image inputs are repeatable with `--input`.',
      'Video aliases: fast, quality, lite. Veo supports prompt, image-to-video, interpolation, reference images, and extension.',
      'Important Veo limits: reference images max 3; reference, extension, 1080p, and 4k require `--duration 8`.',
    ].join('\n');
  },
};
