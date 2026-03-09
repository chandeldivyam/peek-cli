#!/usr/bin/env node

import 'dotenv/config';

import {mkdir, writeFile} from 'node:fs/promises';
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

import {ensureApiKey} from './auth.js';
import {CacheStore, buildCacheKey} from './cache.js';
import {ConfigStore, ensureAppPaths, getAppPaths} from './config.js';
import {GeminiService} from './gemini.js';
import {resolveInputFile} from './input.js';
import {renderAnswer, renderReport} from './output.js';
import {DEFAULT_MODEL, canonicalReportSchema} from './types.js';
import type {
  AnalyzeOptions,
  CanonicalReport,
  ResolvedInputFile,
  WebMode,
} from './types.js';

const paths = getAppPaths();
const configStore = new ConfigStore(paths);
const cacheStore = new CacheStore(paths);

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

async function loadOrAnalyzeReport(params: {
  input: ResolvedInputFile;
  options: AnalyzeOptions;
  gemini: GeminiService;
  quiet?: boolean;
}): Promise<{report: CanonicalReport; renderedText: string}> {
  const cacheKey = buildCacheKey({
    fileHash: params.input.hash,
    model: params.options.model,
    webMode: params.options.webMode,
  });

  if (!params.options.refresh) {
    const cached = await cacheStore.getByCacheKey(cacheKey);
    if (cached) {
      if (!params.quiet) {
        log.success(`Cache hit for ${params.input.displayPath}`);
      }
      return {report: cached.report, renderedText: cached.renderedText};
    }
  }

  const progress = spinner();
  progress.start(`Analyzing ${params.input.displayPath}`);
  const latest = await cacheStore.getLatestByFileHash(params.input.hash);
  try {
    const result = await params.gemini.analyzeVideo({
      input: params.input,
      model: params.options.model,
      webMode: params.options.webMode,
      ...(latest?.entry.uploadedFile
        ? {uploadedFile: latest.entry.uploadedFile}
        : {}),
      onProgress(message) {
        progress.message(message);
      },
    });

    const renderedText = renderReport(result.report);
    await cacheStore.store({
      cacheKey,
      fileHash: params.input.hash,
      filePath: params.input.absolutePath,
      model: params.options.model,
      webMode: params.options.webMode,
      report: result.report,
      renderedText,
      ...(result.uploadedFile ? {uploadedFile: result.uploadedFile} : {}),
    });
    progress.stop(`Analysis complete for ${params.input.displayPath}`);
    return {report: result.report, renderedText};
  } catch (error) {
    progress.error(`Analysis failed for ${params.input.displayPath}`);
    throw error;
  }
}

async function analyzeFiles(rawFiles: string[], options: RuntimeOptions): Promise<void> {
  await ensureAppPaths(paths);
  const apiKey = await ensureApiKey({configStore});
  const gemini = new GeminiService(apiKey);

  const resolvedFiles = await Promise.all(rawFiles.map((rawFile) => resolveInputFile(rawFile)));
  const reports: CanonicalReport[] = [];
  const renderedOutputs: string[] = [];

  intro('peek');

  for (const input of resolvedFiles) {
    const loaded = await loadOrAnalyzeReport({
      input,
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

async function inspectFile(rawFile: string): Promise<void> {
  await ensureAppPaths(paths);
  const input = await resolveInputFile(rawFile);
  let report: CanonicalReport | undefined =
    (await cacheStore.getLatestByFileHash(input.hash))?.report;

  if (!report) {
    const apiKey = await ensureApiKey({configStore});
    const gemini = new GeminiService(apiKey);
    const loaded = await loadOrAnalyzeReport({
      input,
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

async function askQuestion(rawFile: string, question: string, web: boolean): Promise<void> {
  await ensureAppPaths(paths);
  const input = await resolveInputFile(rawFile);
  const apiKey = await ensureApiKey({configStore});
  const gemini = new GeminiService(apiKey);

  const baseReport = await loadOrAnalyzeReport({
    input,
    options: {
      model: DEFAULT_MODEL,
      refresh: false,
      webMode: 'enabled',
    },
    gemini,
    quiet: true,
  });

  const cached = await cacheStore.getLatestByFileHash(input.hash);
  const progress = spinner();
  progress.start(`Answering question for ${input.displayPath}`);
  try {
    const answer = await gemini.answerQuestion({
      report: baseReport.report,
      question,
      webMode: normalizeWebMode(web),
      ...(web ? {input} : {}),
      ...(cached?.entry.uploadedFile ? {uploadedFile: cached.entry.uploadedFile} : {}),
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

async function runAuth(): Promise<void> {
  await ensureAppPaths(paths);
  await ensureApiKey({configStore, forcePrompt: true});
}

async function clearCache(file?: string, clearAll = false): Promise<void> {
  await ensureAppPaths(paths);

  if (clearAll) {
    await cacheStore.clearAll();
    log.success('Cleared the peek cache index.');
    return;
  }

  if (!file) {
    throw new Error('Pass a file path or use --all.');
  }

  const input = await resolveInputFile(file);
  const removedEntries = await cacheStore.clearByFileHash(input.hash);
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
    .description('Deep video analysis CLI powered by Gemini.')
    .version('0.1.2')
    .argument('[files...]', 'Explicit video file paths to analyze');

  program
    .addOption(new Option('--model <model>', 'Gemini model to use').default(DEFAULT_MODEL))
    .option('--refresh', 'Bypass the cache and force a fresh analysis', false)
    .option('--json', 'Print JSON instead of rendered text', false)
    .option('--web', 'Enable grounded web search during analysis', true)
    .option('--no-web', 'Disable grounded web search during analysis')
    .option('-o, --output <path>', 'Write the final output to a file')
    .action(async (files: string[], options: RuntimeOptions, command: Command) => {
      if (!files || files.length === 0) {
        program.help();
      }
      await analyzeFiles(files, resolveRuntimeOptions(options, command));
    });

  program
    .command('analyze')
    .description('Analyze one or more explicit video files.')
    .argument('<files...>', 'Explicit video file paths')
    .addHelpText('after', `\n${sharedOptionHelp}\n`)
    .action(async (files: string[], options: RuntimeOptions, command: Command) => {
      await analyzeFiles(files, resolveRuntimeOptions(options, command));
    });

  program
    .command('inspect')
    .description('Open the Ink inspector for a cached report.')
    .argument('<file>', 'Video file path')
    .action(async (file: string) => {
      await inspectFile(file);
    });

  program
    .command('ask')
    .description('Ask a follow-up question using the cached canonical report.')
    .argument('<file>', 'Video file path')
    .argument('<question>', 'Question to ask')
    .option('--web', 'Re-ground the answer on live web results and the video', false)
    .action(async (file: string, question: string, options: {web: boolean}) => {
      await askQuestion(file, question, options.web);
    });

  program
    .command('auth')
    .description('Enter and verify your GEMINI_API_KEY.')
    .action(async () => {
      await runAuth();
    });

  const cacheCommand = program.command('cache').description('Manage the local cache.');
  cacheCommand
    .command('clear')
    .description('Clear cached reports for a file or for the whole cache.')
    .argument('[file]', 'Video file path')
    .option('--all', 'Clear the entire cache index', false)
    .action(async (file: string | undefined, options: {all: boolean}) => {
      await clearCache(file, options.all);
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
