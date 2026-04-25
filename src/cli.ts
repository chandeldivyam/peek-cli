#!/usr/bin/env node

import 'dotenv/config';

import {mkdir, stat, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import React from 'react';
import {
  intro,
  log,
  note,
  outro,
  spinner,
} from '@clack/prompts';
import {Command, Option} from 'commander';

import {ensureApiKey, ensureProviderApiKey} from './auth.js';
import {CacheStore, buildCacheKey} from './cache.js';
import {ConfigStore, ensureAppPaths, getAppPaths} from './config.js';
import {
  buildGenerationId,
  buildImageCreateRequest,
  buildVideoCreateRequest,
  planOutputAssets,
  toGeneratedOutputAssets,
} from './generation.js';
import {GenerationStore} from './generation-store.js';
import {GeminiService} from './gemini.js';
import {resolveInputBundle} from './input.js';
import {computeFileHash} from './fs-utils.js';
import {renderAnswer, renderGenerationRecord, renderReport} from './output.js';
import {
  getGenerationProvider,
  parseGenerationProvider,
  renderAgentHelp,
} from './providers/index.js';
import {isSupportedRemoteUrl} from './remote.js';
import {installLatestRelease} from './self-update.js';
import {DEFAULT_MODEL, canonicalReportSchema} from './types.js';
import type {
  AnalyzeOptions,
  CanonicalReport,
  GenerationProviderId,
  GenerationInputSource,
  GenerationRecord,
  ResolvedInputBundle,
  ResolvedAsset,
  WebMode,
} from './types.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as {version?: string};
const CLI_VERSION = packageJson.version ?? '0.0.0';

const paths = getAppPaths();
const configStore = new ConfigStore(paths);
const cacheStore = new CacheStore(paths);
const generationStore = new GenerationStore(paths);

interface RuntimeOptions {
  model: string;
  refresh: boolean;
  json: boolean;
  web: boolean;
  output?: string;
}

function resolveRuntimeOptions(
  rawOptions: RuntimeOptions | Command,
  command?: Command,
): RuntimeOptions {
  const rawSource =
    rawOptions instanceof Command
      ? (rawOptions.opts() as Partial<RuntimeOptions>)
      : (rawOptions as Partial<RuntimeOptions>);
  const commandSource =
    command instanceof Command
      ? ({
          ...command.opts(),
          ...(typeof command.optsWithGlobals === 'function'
            ? command.optsWithGlobals()
            : {}),
        } as Partial<RuntimeOptions>)
      : {};
  const source = {...rawSource, ...commandSource};

  return {
    model: source.model ?? DEFAULT_MODEL,
    refresh: source.refresh ?? false,
    json: source.json ?? false,
    web: source.web ?? true,
    ...(source.output ? {output: source.output} : {}),
  };
}

function normalizeWebMode(enabled: boolean): WebMode {
  return enabled ? 'enabled' : 'disabled';
}

function ensureOutputPath(outputPath: string): string {
  return path.resolve(outputPath);
}

async function persistOutput(outputPath: string, contents: string): Promise<void> {
  const absolutePath = ensureOutputPath(outputPath);
  await mkdir(path.dirname(absolutePath), {recursive: true});
  await writeFile(absolutePath, contents);
}

function collectValues(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function resolveInheritedOptionValue<T>(
  command: Command,
  key: keyof T,
): T[keyof T] | undefined {
  let current = command.parent;

  while (current) {
    const source = current.getOptionValueSource(String(key));
    if (source && source !== 'default') {
      return current.opts()[String(key)] as T[keyof T];
    }
    current = current.parent;
  }

  return undefined;
}

function resolveSubcommandOptions<T extends Record<string, unknown>>(command: Command): T {
  const localOptions = command.opts() as T;

  for (const key of Object.keys(localOptions) as Array<keyof T>) {
    if (command.getOptionValueSource(String(key)) === 'default') {
      const inheritedValue = resolveInheritedOptionValue<T>(command, key);
      if (typeof inheritedValue !== 'undefined') {
        localOptions[key] = inheritedValue;
      }
    }
  }

  return localOptions;
}

async function resolveGenerationSource(rawInput: string): Promise<{
  rawInput: string;
  source: ResolvedInputBundle['source'];
  assets: ResolvedAsset[];
}> {
  const bundle = await resolveInputBundle({rawInput, paths});
  return {
    rawInput,
    source: bundle.source,
    assets: bundle.assets,
  };
}

function toGenerationInputSources(
  inputSources: Array<{
    source: ResolvedInputBundle['source'];
    assets: ResolvedAsset[];
  }>,
): GenerationInputSource[] {
  return inputSources.map((inputSource) => ({
    source: inputSource.source,
    assets: inputSource.assets.map((asset) => ({
      index: asset.index,
      kind: asset.kind,
      path: asset.absolutePath,
      hash: asset.hash,
      sizeBytes: asset.sizeBytes,
      mimeType: asset.mimeType,
      modifiedTime: asset.modifiedTime,
    })),
  }));
}

async function collectStoredOutputs(pathsToInspect: Array<{
  path: string;
  mimeType: string;
  kind: 'image' | 'video';
}>): Promise<
  Array<{
    path: string;
    hash: string;
    sizeBytes: number;
    mimeType: string;
    kind: 'image' | 'video';
  }>
> {
  return await Promise.all(
    pathsToInspect.map(async (output) => {
      const fileInfo = await stat(output.path);
      return {
        path: output.path,
        hash: await computeFileHash(output.path),
        sizeBytes: fileInfo.size,
        mimeType: output.mimeType,
        kind: output.kind,
      };
    }),
  );
}

async function loadOrAnalyzeReport(params: {
  bundle: ResolvedInputBundle;
  options: AnalyzeOptions;
  gemini: GeminiService;
  quiet?: boolean;
}): Promise<{report: CanonicalReport; renderedText: string}> {
  const cacheKey = buildCacheKey({
    sourceHash: params.bundle.sourceHash,
    model: params.options.model,
    webMode: params.options.webMode,
  });

  if (!params.options.refresh) {
    const cached = await cacheStore.getByCacheKey(cacheKey);
    if (cached) {
      if (!params.quiet) {
        log.success(`Cache hit for ${params.bundle.source.displayLabel}`);
      }
      return {report: cached.report, renderedText: cached.renderedText};
    }
  }

  const progress = spinner();
  progress.start(`Analyzing ${params.bundle.source.displayLabel}`);
  const latest = await cacheStore.getLatestBySourceHash(params.bundle.sourceHash);

  try {
    const result = await params.gemini.analyzeBundle({
      bundle: params.bundle,
      model: params.options.model,
      webMode: params.options.webMode,
      ...(latest?.entry.uploadedAssets ? {uploadedAssets: latest.entry.uploadedAssets} : {}),
      onProgress(message) {
        progress.message(message);
      },
    });

    const renderedText = renderReport(result.report);
    await cacheStore.store({
      cacheKey,
      sourceHash: params.bundle.sourceHash,
      sourceInput: params.bundle.source.originalInput,
      model: params.options.model,
      webMode: params.options.webMode,
      report: result.report,
      renderedText,
      ...(result.uploadedAssets ? {uploadedAssets: result.uploadedAssets} : {}),
    });
    progress.stop(`Analysis complete for ${params.bundle.source.displayLabel}`);
    return {report: result.report, renderedText};
  } catch (error) {
    progress.error(`Analysis failed for ${params.bundle.source.displayLabel}`);
    throw error;
  }
}

async function analyzeSources(rawInputs: string[], options: RuntimeOptions): Promise<void> {
  await ensureAppPaths(paths);
  const apiKey = await ensureApiKey({configStore});
  const gemini = new GeminiService(apiKey);
  const reports: CanonicalReport[] = [];
  const renderedOutputs: string[] = [];

  intro('peek');

  for (const rawInput of rawInputs) {
    const bundle = await resolveInputBundle({
      rawInput,
      paths,
      refresh: options.refresh,
    });
    const loaded = await loadOrAnalyzeReport({
      bundle,
      options: {
        model: options.model,
        refresh: options.refresh,
        webMode: normalizeWebMode(options.web),
      },
      gemini,
    });
    reports.push(loaded.report);
    renderedOutputs.push(loaded.renderedText);
  }

  const serializedOutput = options.json
    ? JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)
    : renderedOutputs.join('\n\n' + '='.repeat(72) + '\n\n');

  if (options.output) {
    await persistOutput(options.output, `${serializedOutput}\n`);
    note(options.output, 'Saved output');
  } else {
    process.stdout.write(`${serializedOutput}\n`);
  }

  outro(
    reports.length === 1
      ? 'peek finished.'
      : `peek finished ${reports.length} analyses.`,
  );
}

async function inspectSource(rawInput: string): Promise<void> {
  await ensureAppPaths(paths);
  const bundle = await resolveInputBundle({rawInput, paths});
  let report: CanonicalReport | undefined =
    (await cacheStore.getLatestBySourceHash(bundle.sourceHash))?.report;

  if (!report) {
    const apiKey = await ensureApiKey({configStore});
    const gemini = new GeminiService(apiKey);
    const loaded = await loadOrAnalyzeReport({
      bundle,
      options: {
        model: DEFAULT_MODEL,
        refresh: false,
        webMode: 'enabled',
      },
      gemini,
    });
    report = loaded.report;
  }

  const parsedReport = canonicalReportSchema.parse(report);
  const {render} = await import('ink');
  const {InspectApp} = await import('./inspect.js');
  const app = render(React.createElement(InspectApp, {report: parsedReport}), {
    exitOnCtrlC: true,
  });
  await app.waitUntilExit();
}

async function askQuestion(rawInput: string, question: string, web: boolean): Promise<void> {
  await ensureAppPaths(paths);
  const bundle = await resolveInputBundle({rawInput, paths});
  const apiKey = await ensureApiKey({configStore});
  const gemini = new GeminiService(apiKey);

  const baseReport = await loadOrAnalyzeReport({
    bundle,
    options: {
      model: DEFAULT_MODEL,
      refresh: false,
      webMode: 'enabled',
    },
    gemini,
    quiet: true,
  });

  const cached = await cacheStore.getLatestBySourceHash(bundle.sourceHash);
  const progress = spinner();
  progress.start(`Answering question for ${bundle.source.displayLabel}`);
  try {
    const answer = await gemini.answerQuestion({
      report: baseReport.report,
      question,
      webMode: normalizeWebMode(web),
      ...(web ? {bundle} : {}),
      ...(cached?.entry.uploadedAssets ? {uploadedAssets: cached.entry.uploadedAssets} : {}),
      onProgress(message) {
        progress.message(message);
      },
    });
    progress.stop('Answer ready');
    process.stdout.write(`${renderAnswer(answer)}\n`);
  } catch (error) {
    progress.error('Question failed');
    throw error;
  }
}

async function createImage(prompt: string, options: {
  provider?: string;
  model?: string;
  input: string[];
  count?: number;
  aspectRatio?: string;
  size?: string;
  personGeneration?: 'allow_all' | 'allow_adult' | 'allow_none';
  output?: string;
  json?: boolean;
}): Promise<void> {
  await ensureAppPaths(paths);
  const providerId = parseGenerationProvider(options.provider);
  const provider = getGenerationProvider(providerId);
  const inputSources = await Promise.all((options.input ?? []).map((input) => resolveGenerationSource(input)));
  const request = buildImageCreateRequest({
    provider: providerId,
    prompt,
    inputSources,
    ...(options.model ? {model: options.model} : {}),
    ...(typeof options.count === 'number' ? {count: options.count} : {}),
    ...(options.aspectRatio ? {aspectRatio: options.aspectRatio} : {}),
    ...(options.size ? {imageSize: options.size} : {}),
    ...(options.personGeneration ? {personGeneration: options.personGeneration} : {}),
    ...(options.output ? {outputPath: options.output} : {}),
    ...(typeof options.json === 'boolean' ? {json: options.json} : {}),
  });
  provider.validateImageRequest(request);
  const apiKey = await ensureProviderApiKey({configStore, provider: providerId});
  const client = provider.createClient(apiKey);

  intro('peek create image');
  const progress = spinner();
  progress.start(`Generating image with ${provider.label} ${request.modelChoice.model}`);

  try {
    const generatedOutputs = await client.generateImages({
      request,
      onProgress(message) {
        progress.message(message);
      },
    });

    const plannedOutputs = planOutputAssets({
      kind: 'image',
      count: generatedOutputs.length,
      mimeTypes: generatedOutputs.map((output) => output.mimeType),
      prompt: request.prompt,
      ...(request.outputPath ? {outputPath: request.outputPath} : {}),
    });

    for (const plannedOutput of plannedOutputs) {
      await mkdir(path.dirname(plannedOutput.path), {recursive: true});
    }

    await Promise.all(
      generatedOutputs.map((output, index) =>
        writeFile(plannedOutputs[index]!.path, output.bytes),
      ),
    );

    const createdAt = new Date().toISOString();
    const record: GenerationRecord = {
      id: buildGenerationId(),
      provider: request.provider,
      kind: 'image',
      mode: inputSources.length > 0 ? 'edit' : 'prompt',
      createdAt,
      model: request.modelChoice.model,
      ...(request.modelChoice.alias ? {modelAlias: request.modelChoice.alias} : {}),
      prompt: request.prompt,
      inputs: toGenerationInputSources(request.inputSources),
      outputs: toGeneratedOutputAssets({
        createdAt,
        outputs: await collectStoredOutputs(
          plannedOutputs.map((plannedOutput) => ({
            path: plannedOutput.path,
            mimeType: plannedOutput.mimeType,
            kind: plannedOutput.kind,
          })),
        ),
      }),
      options: {
        provider: request.provider,
        count: request.count,
        ...(request.aspectRatio ? {aspectRatio: request.aspectRatio} : {}),
        ...(request.imageSize ? {imageSize: request.imageSize} : {}),
        ...(request.personGeneration ? {personGeneration: request.personGeneration} : {}),
        input: options.input,
      },
    };

    await generationStore.store(record);
    progress.stop('Image generation complete');

    process.stdout.write(
      request.json
        ? `${JSON.stringify(record, null, 2)}\n`
        : `${renderGenerationRecord(record)}\n`,
    );
    outro('peek finished.');
  } catch (error) {
    progress.error('Image generation failed');
    throw error;
  }
}

async function createVideo(prompt: string, options: {
  provider?: string;
  model?: string;
  image?: string;
  lastFrame?: string;
  reference: string[];
  video?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  personGeneration?: 'allow_all' | 'allow_adult';
  negativePrompt?: string;
  seed?: number;
  output?: string;
  json?: boolean;
}): Promise<void> {
  await ensureAppPaths(paths);
  const providerId = parseGenerationProvider(options.provider);
  const provider = getGenerationProvider(providerId);

  const imageSource = options.image ? await resolveGenerationSource(options.image) : undefined;
  const lastFrameSource = options.lastFrame
    ? await resolveGenerationSource(options.lastFrame)
    : undefined;
  const referenceSources = await Promise.all(
    (options.reference ?? []).map((input) => resolveGenerationSource(input)),
  );
  const videoSource = options.video ? await resolveGenerationSource(options.video) : undefined;

  const request = buildVideoCreateRequest({
    provider: providerId,
    prompt,
    ...(imageSource ? {imageSource} : {}),
    ...(lastFrameSource ? {lastFrameSource} : {}),
    referenceSources,
    ...(videoSource ? {videoSource} : {}),
    ...(options.model ? {model: options.model} : {}),
    ...(options.aspectRatio ? {aspectRatio: options.aspectRatio} : {}),
    ...(typeof options.duration === 'number'
      ? {durationSeconds: options.duration as 4 | 6 | 8}
      : {}),
    ...(options.resolution ? {resolution: options.resolution} : {}),
    ...(options.personGeneration ? {personGeneration: options.personGeneration} : {}),
    ...(options.negativePrompt ? {negativePrompt: options.negativePrompt} : {}),
    ...(typeof options.seed === 'number' ? {seed: options.seed} : {}),
    ...(options.output ? {outputPath: options.output} : {}),
    ...(typeof options.json === 'boolean' ? {json: options.json} : {}),
  });
  provider.validateVideoRequest(request);
  const apiKey = await ensureProviderApiKey({configStore, provider: providerId});
  const client = provider.createClient(apiKey);

  intro('peek create video');
  const progress = spinner();
  progress.start(`Generating video with ${provider.label} ${request.modelChoice.model}`);

  try {
    const plannedOutputs = planOutputAssets({
      kind: 'video',
      count: 1,
      mimeTypes: ['video/mp4'],
      prompt: request.prompt,
      ...(request.outputPath ? {outputPath: request.outputPath} : {}),
    });

    const plannedOutput = plannedOutputs[0]!;
    await mkdir(path.dirname(plannedOutput.path), {recursive: true});

    const result = await client.generateVideo({
      request,
      outputPath: plannedOutput.path,
      onProgress(message) {
        progress.message(message);
      },
    });

    const createdAt = new Date().toISOString();
    const record: GenerationRecord = {
      id: buildGenerationId(),
      provider: request.provider,
      kind: 'video',
      mode: request.mode,
      createdAt,
      model: request.modelChoice.model,
      ...(request.modelChoice.alias ? {modelAlias: request.modelChoice.alias} : {}),
      prompt: request.prompt,
      inputs: toGenerationInputSources(request.inputSources),
      outputs: toGeneratedOutputAssets({
        createdAt,
        outputs: await collectStoredOutputs([
          {
            path: plannedOutput.path,
            mimeType: result.mimeType,
            kind: 'video',
          },
        ]),
      }),
      options: {
        provider: request.provider,
        aspectRatio: request.aspectRatio,
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        personGeneration: request.personGeneration,
        ...(request.negativePrompt ? {negativePrompt: request.negativePrompt} : {}),
        ...(typeof request.seed === 'number' ? {seed: request.seed} : {}),
        ...(options.image ? {image: options.image} : {}),
        ...(options.lastFrame ? {lastFrame: options.lastFrame} : {}),
        reference: options.reference,
        ...(options.video ? {video: options.video} : {}),
      },
      ...(result.operationName ? {operationName: result.operationName} : {}),
      ...(result.usage ? {usage: result.usage} : {}),
    };

    await generationStore.store(record);
    progress.stop('Video generation complete');

    process.stdout.write(
      request.json
        ? `${JSON.stringify(record, null, 2)}\n`
        : `${renderGenerationRecord(record)}\n`,
    );
    outro('peek finished.');
  } catch (error) {
    progress.error('Video generation failed');
    throw error;
  }
}

async function runAuth(provider?: GenerationProviderId): Promise<void> {
  await ensureAppPaths(paths);
  const providers: GenerationProviderId[] = provider ? [provider] : ['gemini', 'xai', 'openrouter'];

  for (const providerId of providers) {
    await ensureProviderApiKey({configStore, provider: providerId, forcePrompt: true});
  }
}

async function runInstall(version?: string): Promise<void> {
  const progress = spinner();
  progress.start(
    version?.trim()
      ? `Installing peek ${version.trim()}`
      : 'Installing the latest peek release',
  );

  try {
    const result = await installLatestRelease(version);
    progress.stop('peek install completed');
    note(result.prefix, 'Install prefix');
    note(result.tarballUrl, 'Release asset');
    process.stdout.write(
      `Installed peek ${result.versionLabel} into ${path.join(result.prefix, 'bin', 'peek')}\n`,
    );
    outro('Run `peek --help` to confirm the updated binary.');
  } catch (error) {
    progress.error('peek install failed');
    throw error;
  }
}

async function clearCache(source?: string, clearAll = false): Promise<void> {
  await ensureAppPaths(paths);

  if (clearAll) {
    await cacheStore.clearAll();
    log.success('Cleared the peek cache index.');
    return;
  }

  if (!source) {
    throw new Error('Pass a file path, URL, or use --all.');
  }

  const removedEntries = isSupportedRemoteUrl(source)
    ? await cacheStore.clearBySourceInput(source)
    : await cacheStore.clearBySourceHash((await resolveInputBundle({rawInput: source, paths})).sourceHash);

  log.success(`Removed ${removedEntries} cached entr${removedEntries === 1 ? 'y' : 'ies'}.`);
}

async function main(): Promise<void> {
  const program = new Command();
  const sharedOptionHelp = [
    'Shared analyze options:',
    '  --model <model>     Gemini model to use',
    '  --refresh           Bypass the cache and force a fresh analysis',
    '  --json              Print JSON instead of rendered text',
    '  --web / --no-web    Enable or disable grounded web search',
    '  -o, --output <path> Write the final output to a file',
  ].join('\n');

  program
    .name('peek')
    .description('Media analysis CLI for local files, Instagram, and YouTube.')
    .enablePositionalOptions()
    .version(CLI_VERSION)
    .argument('[sources...]', 'Explicit image/video file paths or supported URLs to analyze');

  program
    .addOption(new Option('--model <model>', 'Gemini model to use').default(DEFAULT_MODEL))
    .option('--refresh', 'Bypass the cache and force a fresh analysis', false)
    .option('--json', 'Print JSON instead of rendered text', false)
    .option('--web', 'Enable grounded web search during analysis', true)
    .option('--no-web', 'Disable grounded web search during analysis')
    .option('--agent-help', 'Print agent-oriented usage guidance', false)
    .option('-o, --output <path>', 'Write the final output to a file')
    .action(async (sources: string[], options: RuntimeOptions & {agentHelp?: boolean}, command: Command) => {
      if (options.agentHelp) {
        process.stdout.write(`${renderAgentHelp('root')}\n`);
        return;
      }

      if (!sources || sources.length === 0) {
        program.help();
      }
      await analyzeSources(sources, resolveRuntimeOptions(options, command));
    });

  program
    .command('analyze')
    .description('Analyze one or more explicit image/video files or supported URLs.')
    .argument('<sources...>', 'Explicit file paths or supported URLs')
    .addHelpText('after', `\n${sharedOptionHelp}\n`)
    .action(async (sources: string[], options: RuntimeOptions, command: Command) => {
      await analyzeSources(sources, resolveRuntimeOptions(options, command));
    });

  program
    .command('inspect')
    .description('Open the Ink inspector for a cached report.')
    .argument('<source>', 'File path or supported URL')
    .action(async (source: string) => {
      await inspectSource(source);
    });

  program
    .command('ask')
    .description('Ask a follow-up question using the cached canonical report.')
    .argument('<source>', 'File path or supported URL')
    .argument('<question>', 'Question to ask')
    .option('--web', 'Re-ground the answer on live web results and the media bundle', false)
    .action(async (source: string, question: string, options: {web: boolean}) => {
      await askQuestion(source, question, options.web);
    });

  program
    .command('auth')
    .description('Enter and verify API keys.')
    .option('--provider <provider>', 'Provider to authenticate: gemini, xai, or openrouter')
    .action(async (options: {provider?: string}) => {
      await runAuth(options.provider ? parseGenerationProvider(options.provider) : undefined);
    });

  program
    .command('install')
    .description('Install or update peek from the latest GitHub Release.')
    .option('--version <tag>', 'Install a specific release tag, for example v0.1.2')
    .action(async (options: {version?: string}) => {
      await runInstall(options.version);
    });

  const createCommand = program
    .command('create')
    .description('Generate images or videos with provider-backed models.')
    .option('--agent-help', 'Print agent-oriented generation guidance', false)
    .action((options: {agentHelp?: boolean}) => {
      if (options.agentHelp) {
        process.stdout.write(`${renderAgentHelp('create')}\n`);
        return;
      }

      createCommand.help();
    });

  createCommand
    .command('image')
    .description('Generate one or more images.')
    .argument('[prompt]', 'Prompt to generate from')
    .option('--agent-help', 'Print agent-oriented image generation guidance', false)
    .option('--provider <provider>', 'Generation provider: gemini, xai, or openrouter', 'gemini')
    .option('--model <model>', 'Image model alias or raw model id')
    .option('--input <source>', 'Reference image input (repeatable)', collectValues, [])
    .option('--count <count>', 'Number of images to generate', (value) => Number.parseInt(value, 10), 1)
    .option('--aspect-ratio <ratio>', 'Image aspect ratio, for example 1:1 or 16:9')
    .option('--size <size>', 'Image size/resolution, for example 1K, 2K, 4K, 1k, or 2k')
    .option('--person-generation <mode>', 'allow_all, allow_adult, or allow_none')
    .option('--json', 'Print generation metadata as JSON', false)
    .option('-o, --output <path>', 'Output file or directory for generated assets')
    .action(async function (
      this: Command,
      prompt: string | undefined,
    ) {
      const resolved = resolveSubcommandOptions(this) as {
        agentHelp?: boolean;
        provider?: string;
        model?: string;
        input: string[];
        count?: number;
        aspectRatio?: string;
        size?: string;
        personGeneration?: 'allow_all' | 'allow_adult' | 'allow_none';
        output?: string;
        json?: boolean;
      };

      if (resolved.agentHelp) {
        process.stdout.write(`${renderAgentHelp('image')}\n`);
        return;
      }

      if (!prompt) {
        this.help();
      }

      await createImage(
        prompt,
        resolved,
      );
    });

  createCommand
    .command('video')
    .description('Generate a video.')
    .argument('[prompt]', 'Prompt to generate from')
    .option('--agent-help', 'Print agent-oriented video generation guidance', false)
    .option('--provider <provider>', 'Generation provider: gemini, xai, or openrouter', 'gemini')
    .option('--model <model>', 'Video model alias or raw model id')
    .option('--image <source>', 'Single input image for image-to-video')
    .option('--last-frame <source>', 'Single final image for interpolation')
    .option('--reference <source>', 'Reference image input (repeatable)', collectValues, [])
    .option('--video <source>', 'Single input video for extension')
    .option('--aspect-ratio <ratio>', 'Video aspect ratio', '16:9')
    .option('--resolution <resolution>', 'Video resolution, for example 480p, 720p, 1080p, or 4k', '720p')
    .option('--duration <seconds>', 'Video duration in seconds', (value) => Number.parseInt(value, 10), 4)
    .option('--person-generation <mode>', 'allow_all or allow_adult')
    .option('--negative-prompt <text>', 'Tell Veo what to avoid')
    .option('--seed <seed>', 'Random seed', (value) => Number.parseInt(value, 10))
    .option('--json', 'Print generation metadata as JSON', false)
    .option('-o, --output <path>', 'Output file or directory for generated assets')
    .action(async function (
      this: Command,
      prompt: string | undefined,
    ) {
      const resolved = resolveSubcommandOptions(this) as {
        agentHelp?: boolean;
        provider?: string;
        model?: string;
        image?: string;
        lastFrame?: string;
        reference: string[];
        video?: string;
        aspectRatio?: string;
        resolution?: string;
        duration?: number;
        personGeneration?: 'allow_all' | 'allow_adult';
        negativePrompt?: string;
        seed?: number;
        output?: string;
        json?: boolean;
      };

      if (resolved.agentHelp) {
        process.stdout.write(`${renderAgentHelp('video')}\n`);
        return;
      }

      if (!prompt) {
        this.help();
      }

      await createVideo(
        prompt,
        resolved,
      );
    });

  const cacheCommand = program.command('cache').description('Manage the local cache.');
  cacheCommand
    .command('clear')
    .description('Clear cached reports for a source or for the whole cache.')
    .argument('[source]', 'File path or supported URL')
    .option('--all', 'Clear the entire cache index', false)
    .action(async (source: string | undefined, options: {all: boolean}) => {
      await clearCache(source, options.all);
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
