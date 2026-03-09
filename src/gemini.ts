import {
  FileState,
  GoogleGenAI,
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
  ReportSource,
  ResolvedInputFile,
  UploadedFileReference,
  WebMode,
} from './types.js';

interface ProgressReporter {
  (message: string): void;
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

function buildAnalysisPrompt(displayPath: string, webMode: WebMode): string {
  return [
    'Analyze this video deeply and return only JSON matching the provided schema.',
    `Prompt version: ${PROMPT_VERSION}. Schema version: ${REPORT_SCHEMA_VERSION}.`,
    `Source file: ${displayPath}.`,
    'Focus on what happens visually and auditorily, who appears, what text is visible on screen, and the most important sequences.',
    'Make the chapter timeline practical and concise. Use approximate timestamps when needed.',
    'Summaries should be specific, not generic.',
    webMode === 'enabled'
      ? 'Use grounded Google Search results when useful for identifying public context, brands, locations, events, or people. Put grounded conclusions into webInsights.'
      : 'Do not rely on web context. Keep webInsights empty unless the file itself contains web-related context.',
    'If something is uncertain, say so in uncertainties rather than pretending confidence.',
  ].join('\n');
}

function buildFollowUpPrompt(report: CanonicalReport, question: string): string {
  return [
    'You are answering a follow-up question about a previously analyzed video.',
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

  async analyzeVideo(params: {
    input: ResolvedInputFile;
    model?: string;
    webMode: WebMode;
    uploadedFile?: UploadedFileReference;
    onProgress?: ProgressReporter;
  }): Promise<AnalyzeResult> {
    const model = params.model ?? DEFAULT_MODEL;
    const uploadedFile = await this.ensureUploadedFile({
      input: params.input,
      ...(params.uploadedFile ? {uploadedFile: params.uploadedFile} : {}),
      ...(params.onProgress ? {onProgress: params.onProgress} : {}),
    });

    params.onProgress?.('Running Gemini analysis');
    const config = {
      responseMimeType: 'application/json',
      responseJsonSchema: analysisJsonSchema,
      ...(params.webMode === 'enabled' ? {tools: [{googleSearch: {}}]} : {}),
    };
    const response = await this.client.models.generateContent({
      model,
      contents: createUserContent([
        createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
        buildAnalysisPrompt(params.input.displayPath, params.webMode),
      ]),
      config,
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
      file: {
        path: params.input.absolutePath,
        hash: params.input.hash,
        sizeBytes: params.input.sizeBytes,
        mimeType: params.input.mimeType,
        modifiedTime: params.input.modifiedTime,
      },
      analysis: payload,
      sources: grounding.sources,
      searchQueries: grounding.searchQueries,
    };

    return {report, uploadedFile};
  }

  async answerQuestion(params: {
    report: CanonicalReport;
    question: string;
    webMode: WebMode;
    input?: ResolvedInputFile;
    uploadedFile?: UploadedFileReference;
    onProgress?: ProgressReporter;
  }): Promise<AnswerResult> {
    const contents: Array<string | ReturnType<typeof createPartFromUri>> = [];

    if (params.webMode === 'enabled' && params.input) {
      const uploadedFile = await this.ensureUploadedFile({
        input: params.input,
        ...(params.uploadedFile ? {uploadedFile: params.uploadedFile} : {}),
        ...(params.onProgress ? {onProgress: params.onProgress} : {}),
      });
      contents.push(createPartFromUri(uploadedFile.uri, uploadedFile.mimeType));
    }

    contents.push(buildFollowUpPrompt(params.report, params.question));
    params.onProgress?.('Asking follow-up question');
    const config = params.webMode === 'enabled' ? {tools: [{googleSearch: {}}]} : {};

    const response = await this.client.models.generateContent({
      model: params.report.model || DEFAULT_MODEL,
      contents: createUserContent(contents),
      config,
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

  private async ensureUploadedFile(params: {
    input: ResolvedInputFile;
    uploadedFile?: UploadedFileReference;
    onProgress?: ProgressReporter;
  }): Promise<UploadedFileReference> {
    if (hasUsableUpload(params.uploadedFile)) {
      params.onProgress?.('Reusing uploaded file reference');
      return params.uploadedFile;
    }

    params.onProgress?.('Uploading video to Gemini Files API');
    let file = await this.client.files.upload({
      file: params.input.absolutePath,
      config: {mimeType: params.input.mimeType},
    });

    while (!file.state || file.state === FileState.PROCESSING) {
      params.onProgress?.('Waiting for Gemini to finish video processing');
      await sleep(5_000);
      file = await this.client.files.get({name: file.name ?? ''});
    }

    if (file.state !== FileState.ACTIVE || !file.name || !file.uri || !file.mimeType) {
      const detail = file.error?.message ?? file.state ?? 'unknown upload state';
      throw new Error(`Gemini file processing failed: ${detail}`);
    }

    return {
      name: file.name,
      uri: file.uri,
      mimeType: file.mimeType,
      ...(file.expirationTime ? {expirationTime: file.expirationTime} : {}),
    };
  }
}
