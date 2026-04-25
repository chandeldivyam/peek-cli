import {readFile} from 'node:fs/promises';

import {
  FileState,
  GoogleGenAI,
  VideoGenerationReferenceType,
  createPartFromUri,
  createUserContent,
} from '@google/genai';

import {
  API_KEY_VALIDATION_MODEL,
  DEFAULT_MODEL,
  PROMPT_VERSION,
  REPORT_SCHEMA_VERSION,
  analysisJsonSchema,
  analysisPayloadSchema,
} from './types.js';
import type {
  AnalyzeResult,
  AnswerResult,
  CanonicalReport,
  MediaKind,
  ReportSource,
  ResolvedAsset,
  ResolvedInputBundle,
  UploadedAssetReference,
  UploadedFileReference,
  WebMode,
} from './types.js';

interface ProgressReporter {
  (message: string): void;
}

interface GeneratedBinaryOutput {
  bytes: Buffer;
  mimeType: string;
  kind: MediaKind;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJsonText(rawText: string): unknown {
  const trimmed = rawText.trim();
  const stripped = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  return JSON.parse(stripped);
}

function collectGrounding(
  candidate: Record<string, unknown> | undefined,
): {sources: ReportSource[]; searchQueries: string[]} {
  if (!candidate) {
    return {sources: [], searchQueries: []};
  }

  const metadata = candidate.groundingMetadata as
    | {
        webSearchQueries?: string[];
        groundingChunks?: Array<{
          web?: {title?: string; uri?: string; domain?: string};
        }>;
      }
    | undefined;

  const searchQueries = metadata?.webSearchQueries ?? [];
  const seenUrls = new Set<string>();
  const sources: ReportSource[] = [];

  for (const chunk of metadata?.groundingChunks ?? []) {
    const url = chunk.web?.uri?.trim();
    if (!url || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    sources.push({
      title: chunk.web?.title?.trim() || url,
      url,
      ...(chunk.web?.domain?.trim() ? {publisher: chunk.web.domain.trim()} : {}),
      ...(searchQueries[0] ? {query: searchQueries[0]} : {}),
    });
  }

  return {sources, searchQueries};
}

function hasUsableUpload(uploadedFile?: UploadedFileReference): uploadedFile is UploadedFileReference {
  if (!uploadedFile?.name || !uploadedFile.uri || !uploadedFile.mimeType) {
    return false;
  }

  if (!uploadedFile.expirationTime) {
    return true;
  }

  return Date.parse(uploadedFile.expirationTime) > Date.now();
}

function describeAsset(asset: ResolvedAsset): string {
  return `asset ${asset.index + 1} (${asset.kind}, ${asset.mimeType}, ${asset.displayPath})`;
}

function extractImageOutputs(candidate: Record<string, unknown> | undefined): GeneratedBinaryOutput[] {
  const content = candidate?.content as {parts?: Array<{inlineData?: {data?: string; mimeType?: string}}> } | undefined;
  const outputs: GeneratedBinaryOutput[] = [];

  for (const part of content?.parts ?? []) {
    const inlineData = part.inlineData;
    if (!inlineData?.data || !inlineData.mimeType?.startsWith('image/')) {
      continue;
    }

    outputs.push({
      bytes: Buffer.from(inlineData.data, 'base64'),
      mimeType: inlineData.mimeType,
      kind: 'image',
    });
  }

  return outputs;
}

function buildAnalysisPrompt(bundle: ResolvedInputBundle, webMode: WebMode): string {
  const assetList = bundle.assets.map((asset) => `- ${describeAsset(asset)}`).join('\n');

  return [
    'Analyze this media bundle deeply and return only JSON matching the provided schema.',
    `Prompt version: ${PROMPT_VERSION}. Schema version: ${REPORT_SCHEMA_VERSION}.`,
    `Source: ${bundle.source.displayLabel}.`,
    `Asset count: ${bundle.assets.length}.`,
    'Treat assets as an ordered sequence. Preserve that order in assetSummaries and segments via assetIndex.',
    'Use timestamps only for video assets. For images, omit start/end unless a synthetic range is genuinely useful.',
    'Summaries should be specific, not generic.',
    'Describe both visual and audible content when present. If there is no audio in the bundle, omit audioSummary.',
    'Asset list:',
    assetList,
    webMode === 'enabled'
      ? 'Use grounded Google Search results when useful for identifying public context, brands, locations, events, or people. Put grounded conclusions into webInsights.'
      : 'Do not rely on web context. Keep webInsights empty unless the media itself contains web-related context.',
    'If something is uncertain, say so in uncertainties rather than pretending confidence.',
  ].join('\n');
}

function buildFollowUpPrompt(report: CanonicalReport, question: string): string {
  return [
    'You are answering a follow-up question about a previously analyzed media bundle.',
    'Prefer the cached report as the primary source of truth.',
    'If web grounding is enabled for this turn, use it only to enrich or verify the answer.',
    'Be explicit about uncertainty.',
    '',
    'Question:',
    question,
    '',
    'Cached canonical report JSON:',
    JSON.stringify(report, null, 2),
  ].join('\n');
}

export class GeminiService {
  private readonly client: GoogleGenAI;

  constructor(private readonly apiKey: string) {
    this.client = new GoogleGenAI({apiKey});
  }

  async verifyApiKey(): Promise<void> {
    await this.client.models.get({model: API_KEY_VALIDATION_MODEL});
  }

  async analyzeBundle(params: {
    bundle: ResolvedInputBundle;
    model?: string;
    webMode: WebMode;
    uploadedAssets?: UploadedAssetReference[];
    onProgress?: ProgressReporter;
  }): Promise<AnalyzeResult> {
    const model = params.model ?? DEFAULT_MODEL;
    const uploadedAssets = await this.ensureUploadedAssets({
      bundle: params.bundle,
      ...(params.uploadedAssets ? {cachedUploads: params.uploadedAssets} : {}),
      ...(params.onProgress ? {onProgress: params.onProgress} : {}),
    });

    params.onProgress?.('Running Gemini analysis');
    const response = await this.client.models.generateContent({
      model,
      contents: createUserContent([
        ...uploadedAssets.map((asset) =>
          createPartFromUri(asset.uploadedFile.uri, asset.uploadedFile.mimeType),
        ),
        buildAnalysisPrompt(params.bundle, params.webMode),
      ]),
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: analysisJsonSchema,
        ...(params.webMode === 'enabled' ? {tools: [{googleSearch: {}}]} : {}),
      },
    });

    params.onProgress?.('Validating structured response');
    if (!response.text?.trim()) {
      throw new Error('Gemini returned an empty structured response.');
    }

    const payload = analysisPayloadSchema.parse(parseJsonText(response.text));
    const candidate = response.candidates?.[0] as Record<string, unknown> | undefined;
    const grounding = collectGrounding(candidate);

    const report: CanonicalReport = {
      generatedAt: new Date().toISOString(),
      model,
      schemaVersion: REPORT_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      webMode: params.webMode,
      source: params.bundle.source,
      assets: params.bundle.assets.map((asset) => ({
        index: asset.index,
        kind: asset.kind,
        path: asset.absolutePath,
        hash: asset.hash,
        sizeBytes: asset.sizeBytes,
        mimeType: asset.mimeType,
        modifiedTime: asset.modifiedTime,
      })),
      analysis: payload,
      sources: grounding.sources,
      searchQueries: grounding.searchQueries,
    };

    return {report, uploadedAssets};
  }

  async answerQuestion(params: {
    report: CanonicalReport;
    question: string;
    webMode: WebMode;
    bundle?: ResolvedInputBundle;
    uploadedAssets?: UploadedAssetReference[];
    onProgress?: ProgressReporter;
  }): Promise<AnswerResult> {
    const contents: Array<string | ReturnType<typeof createPartFromUri>> = [];

    if (params.webMode === 'enabled' && params.bundle) {
      const uploadedAssets = await this.ensureUploadedAssets({
        bundle: params.bundle,
        ...(params.uploadedAssets ? {cachedUploads: params.uploadedAssets} : {}),
        ...(params.onProgress ? {onProgress: params.onProgress} : {}),
      });
      contents.push(
        ...uploadedAssets.map((asset) =>
          createPartFromUri(asset.uploadedFile.uri, asset.uploadedFile.mimeType),
        ),
      );
    }

    contents.push(buildFollowUpPrompt(params.report, params.question));
    params.onProgress?.('Asking follow-up question');

    const response = await this.client.models.generateContent({
      model: params.report.model || DEFAULT_MODEL,
      contents: createUserContent(contents),
      config: params.webMode === 'enabled' ? {tools: [{googleSearch: {}}]} : {},
    });

    const candidate = response.candidates?.[0] as Record<string, unknown> | undefined;
    const grounding = collectGrounding(candidate);
    if (!response.text?.trim()) {
      throw new Error('Gemini returned an empty answer.');
    }

    return {
      answer: response.text.trim(),
      sources: grounding.sources,
      searchQueries: grounding.searchQueries,
    };
  }

  async generateImages(params: {
    prompt: string;
    model: string;
    count: number;
    aspectRatio?: string;
    imageSize?: '1K' | '2K' | '4K';
    personGeneration?: 'allow_all' | 'allow_adult' | 'allow_none';
    inputAssets: ResolvedAsset[];
    onProgress?: ProgressReporter;
  }): Promise<GeneratedBinaryOutput[]> {
    const uploadedInputs = params.inputAssets.length
      ? await this.ensureUploadedResolvedAssets({
          assets: params.inputAssets,
          ...(params.onProgress ? {onProgress: params.onProgress} : {}),
        })
      : [];

    const outputs: GeneratedBinaryOutput[] = [];
    while (outputs.length < params.count) {
      params.onProgress?.(
        `Generating image ${outputs.length + 1} of ${params.count} with ${params.model}`,
      );

      const response = await this.client.models.generateContent({
        model: params.model,
        contents: createUserContent([
          ...uploadedInputs.map((asset) =>
            createPartFromUri(asset.uploadedFile.uri, asset.uploadedFile.mimeType),
          ),
          params.prompt,
        ]),
        config: {
          imageConfig: {
            ...(params.aspectRatio ? {aspectRatio: params.aspectRatio} : {}),
            ...(params.imageSize ? {imageSize: params.imageSize} : {}),
            ...(params.personGeneration
              ? {personGeneration: params.personGeneration.toUpperCase()}
              : {}),
          },
        },
      });

      const candidate = response.candidates?.[0] as Record<string, unknown> | undefined;
      const generated = extractImageOutputs(candidate);
      if (generated.length === 0) {
        throw new Error('Image generation returned no image bytes.');
      }

      outputs.push(...generated);
    }

    return outputs.slice(0, params.count);
  }

  async generateVideo(params: {
    prompt: string;
    model: string;
    aspectRatio: '16:9' | '9:16';
    durationSeconds: 4 | 6 | 8;
    resolution: '720p' | '1080p' | '4k';
    personGeneration: 'allow_all' | 'allow_adult';
    negativePrompt?: string;
    seed?: number;
    image?: ResolvedAsset;
    lastFrame?: ResolvedAsset;
    references: ResolvedAsset[];
    video?: ResolvedAsset;
    outputPath: string;
    onProgress?: ProgressReporter;
  }): Promise<{operationName?: string; mimeType: string}> {
    params.onProgress?.(`Starting Veo generation with ${params.model}`);
    const hasSourceInput = Boolean(params.image || params.lastFrame || params.video);
    let operation = await this.client.models.generateVideos({
      model: params.model,
      ...(hasSourceInput
        ? {
            source: {
              prompt: params.prompt,
              ...(params.image ? {image: await this.readImage(params.image)} : {}),
              ...(params.video ? {video: await this.readVideo(params.video)} : {}),
            },
          }
        : {prompt: params.prompt}),
      config: {
        aspectRatio: params.aspectRatio,
        durationSeconds: params.durationSeconds,
        resolution: params.resolution,
        personGeneration: params.personGeneration,
        ...(params.negativePrompt ? {negativePrompt: params.negativePrompt} : {}),
        ...(typeof params.seed === 'number' ? {seed: params.seed} : {}),
        ...(params.lastFrame ? {lastFrame: await this.readImage(params.lastFrame)} : {}),
        ...(params.references.length > 0
          ? {
              referenceImages: await Promise.all(
                params.references.map(async (asset) => ({
                  image: await this.readImage(asset),
                  referenceType: VideoGenerationReferenceType.ASSET,
                })),
              ),
            }
          : {}),
      },
    });

    while (!operation.done) {
      params.onProgress?.(`Waiting for Veo to finish generation (${params.model})`);
      await sleep(10_000);
      operation = await this.client.operations.getVideosOperation({operation});
    }

    const generatedVideo = operation.response?.generatedVideos?.[0]?.video;
    if (!generatedVideo) {
      const errorMessage =
        (operation.error as {message?: string} | undefined)?.message ??
        operation.response?.raiMediaFilteredReasons?.join(', ') ??
        'unknown video generation failure';
      throw new Error(`Video generation failed: ${errorMessage}`);
    }

    params.onProgress?.(`Downloading generated video to ${params.outputPath}`);
    await this.client.files.download({
      file: generatedVideo,
      downloadPath: params.outputPath,
    });

    return {
      ...(operation.name ? {operationName: operation.name} : {}),
      mimeType: generatedVideo.mimeType || 'video/mp4',
    };
  }

  private async ensureUploadedAssets(params: {
    bundle: ResolvedInputBundle;
    cachedUploads?: UploadedAssetReference[];
    onProgress?: ProgressReporter;
  }): Promise<UploadedAssetReference[]> {
    const cachedUploadMap = new Map(
      (params.cachedUploads ?? []).map((asset) => [asset.assetHash, asset.uploadedFile]),
    );

    const uploadedAssets: UploadedAssetReference[] = [];
    for (const asset of params.bundle.assets) {
      const cachedUpload = cachedUploadMap.get(asset.hash);
      const uploadedFile = await this.ensureUploadedAsset({
        asset,
        ...(cachedUpload ? {uploadedFile: cachedUpload} : {}),
        ...(params.onProgress ? {onProgress: params.onProgress} : {}),
      });
      uploadedAssets.push({
        assetHash: asset.hash,
        uploadedFile,
      });
    }

    return uploadedAssets;
  }

  private async ensureUploadedResolvedAssets(params: {
    assets: ResolvedAsset[];
    cachedUploads?: UploadedAssetReference[];
    onProgress?: ProgressReporter;
  }): Promise<UploadedAssetReference[]> {
    const cachedUploadMap = new Map(
      (params.cachedUploads ?? []).map((asset) => [asset.assetHash, asset.uploadedFile]),
    );

    const uploadedAssets: UploadedAssetReference[] = [];
    for (const asset of params.assets) {
      const cachedUpload = cachedUploadMap.get(asset.hash);
      const uploadedFile = await this.ensureUploadedAsset({
        asset,
        ...(cachedUpload ? {uploadedFile: cachedUpload} : {}),
        ...(params.onProgress ? {onProgress: params.onProgress} : {}),
      });
      uploadedAssets.push({
        assetHash: asset.hash,
        uploadedFile,
      });
    }

    return uploadedAssets;
  }

  private async ensureUploadedAsset(params: {
    asset: ResolvedAsset;
    uploadedFile?: UploadedFileReference;
    onProgress?: ProgressReporter;
  }): Promise<UploadedFileReference> {
    if (hasUsableUpload(params.uploadedFile)) {
      params.onProgress?.(`Reusing uploaded ${describeAsset(params.asset)}`);
      return params.uploadedFile;
    }

    params.onProgress?.(`Uploading ${describeAsset(params.asset)}`);
    let file = await this.client.files.upload({
      file: params.asset.absolutePath,
      config: {mimeType: params.asset.mimeType},
    });

    while (!file.state || file.state === FileState.PROCESSING) {
      params.onProgress?.(`Waiting for Gemini to finish processing ${describeAsset(params.asset)}`);
      await sleep(5_000);
      file = await this.client.files.get({name: file.name ?? ''});
    }

    if (!file.name || !file.uri || !file.mimeType || file.state !== FileState.ACTIVE) {
      const detail = file.error?.message ?? file.state ?? 'unknown upload state';
      throw new Error(`Gemini file processing failed for ${describeAsset(params.asset)}: ${detail}`);
    }

    return {
      name: file.name,
      uri: file.uri,
      mimeType: file.mimeType,
      ...(file.expirationTime ? {expirationTime: file.expirationTime} : {}),
    };
  }

  private async readImage(asset: ResolvedAsset): Promise<{imageBytes: string; mimeType: string}> {
    const bytes = await readFile(asset.absolutePath);
    return {
      imageBytes: bytes.toString('base64'),
      mimeType: asset.mimeType,
    };
  }

  private async readVideo(asset: ResolvedAsset): Promise<{videoBytes: string; mimeType: string}> {
    const bytes = await readFile(asset.absolutePath);
    return {
      videoBytes: bytes.toString('base64'),
      mimeType: asset.mimeType,
    };
  }
}
