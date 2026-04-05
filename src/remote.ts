import {readdir, readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';

import {
  ensureDir,
  hashString,
  readJsonFile,
  writeJsonAtomic,
} from './fs-utils.js';
import {hasCommand, runCommand} from './process-utils.js';
import type {
  AppPaths,
  RemoteProvider,
  SourceDescriptor,
} from './types.js';

interface DownloadManifest {
  source: SourceDescriptor;
  assetRelativePaths: string[];
}

interface YtDlpMetadata {
  _type?: string;
  extractor_key?: string;
  id?: string;
  title?: string;
  webpage_url?: string;
  original_url?: string;
  entries?: Array<{id?: string}>;
  formats?: Array<{format_id?: string}>;
}

type InstagramPathKind = 'p' | 'reel' | 'reels';

function getSourceDirectory(paths: AppPaths, provider: RemoteProvider, url: string): string {
  return path.join(paths.downloadsDir, provider, hashString(url));
}

function getManifestPath(sourceDir: string): string {
  return path.join(sourceDir, 'manifest.json');
}

export function sortMediaFilePaths(paths: string[]): string[] {
  return [...paths].sort((left, right) =>
    path.basename(left).localeCompare(path.basename(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}

async function collectMediaFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, {withFileTypes: true});
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMediaFiles(absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.mp4', '.mov', '.webm', '.mkv', '.m4v'].includes(extension)) {
      files.push(absolutePath);
    }
  }

  return sortMediaFilePaths(files);
}

async function writeManifest(sourceDir: string, manifest: DownloadManifest): Promise<void> {
  await writeJsonAtomic(getManifestPath(sourceDir), manifest);
}

async function readManifest(sourceDir: string): Promise<DownloadManifest | undefined> {
  const manifest = await readJsonFile<DownloadManifest | undefined>(getManifestPath(sourceDir), undefined);
  if (!manifest) {
    return undefined;
  }

  for (const relativePath of manifest.assetRelativePaths) {
    try {
      const info = await stat(path.join(sourceDir, relativePath));
      if (!info.isFile()) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }

  return manifest;
}

async function ensureCommandOrThrow(command: string, installHint: string): Promise<void> {
  if (await hasCommand(command)) {
    return;
  }

  throw new Error(`${command} is required for this source. ${installHint}`);
}

function parseYtDlpMetadata(stdout: string): YtDlpMetadata {
  return JSON.parse(stdout) as YtDlpMetadata;
}

async function probeWithYtDlp(url: string): Promise<YtDlpMetadata> {
  await ensureCommandOrThrow('yt-dlp', 'Install yt-dlp and ensure it is available on PATH.');
  const result = await runCommand('yt-dlp', {
    args: ['-J', '--no-warnings', url],
  });
  return parseYtDlpMetadata(result.stdout);
}

function hasYtDlpMedia(metadata: YtDlpMetadata): boolean {
  if ((metadata.entries?.length ?? 0) > 0) {
    return true;
  }

  return (metadata.formats?.length ?? 0) > 0;
}

async function downloadWithYtDlp(params: {
  url: string;
  sourceDir: string;
  treatAsPlaylist: boolean;
}): Promise<string[]> {
  await ensureCommandOrThrow('yt-dlp', 'Install yt-dlp and ensure it is available on PATH.');
  await ensureCommandOrThrow(
    'ffmpeg',
    'Install ffmpeg and ensure it is available on PATH for remote video downloads.',
  );

  const args = [
    '--no-warnings',
    '--no-progress',
    '--restrict-filenames',
    '--paths',
    params.sourceDir,
    '--output',
    '%(autonumber)03d-%(id)s.%(ext)s',
    '-f',
    'bv*+ba/b',
    '--merge-output-format',
    'mp4',
  ];

  if (!params.treatAsPlaylist) {
    args.push('--no-playlist');
  }

  args.push(params.url);

  await runCommand('yt-dlp', {args});
  const files = await collectMediaFiles(params.sourceDir);
  if (files.length === 0) {
    throw new Error(`yt-dlp did not download any media for ${params.url}`);
  }
  return files;
}

function extractInstagramShortcode(inputUrl: string): string {
  const parsed = new URL(inputUrl);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Unsupported Instagram URL: ${inputUrl}`);
  }

  const [kind, shortcode] = parts;
  if (!kind || !['p', 'reel', 'reels'].includes(kind) || !shortcode) {
    throw new Error(`Unsupported Instagram URL: ${inputUrl}`);
  }

  return shortcode;
}

function getInstagramPathKind(inputUrl: string): InstagramPathKind | undefined {
  const parsed = new URL(inputUrl);
  const [kind] = parsed.pathname.split('/').filter(Boolean);
  if (kind === 'p' || kind === 'reel' || kind === 'reels') {
    return kind;
  }

  return undefined;
}

export function shouldPreferInstaloaderForInstagramUrl(inputUrl: string): boolean {
  try {
    const parsed = new URL(inputUrl);
    if (!parsed.hostname.toLowerCase().endsWith('instagram.com')) {
      return false;
    }

    return getInstagramPathKind(inputUrl) === 'p';
  } catch {
    return false;
  }
}

async function downloadWithInstaloader(params: {
  url: string;
  sourceDir: string;
}): Promise<{files: string[]; source: SourceDescriptor}> {
  await ensureCommandOrThrow(
    'instaloader',
    'Install Instaloader and ensure `instaloader` is available on PATH for Instagram photo posts.',
  );

  const shortcode = extractInstagramShortcode(params.url);
  await runCommand('instaloader', {
    cwd: params.sourceDir,
    args: [
      '--dirname-pattern',
      '.',
      '--filename-pattern',
      '{date_utc}_UTC',
      '--sanitize-paths',
      '--no-captions',
      '--no-metadata-json',
      '--no-compress-json',
      '--no-video-thumbnails',
      '--no-resume',
      '--',
      `-${shortcode}`,
    ],
  });

  const files = await collectMediaFiles(params.sourceDir);
  if (files.length === 0) {
    throw new Error(`instaloader did not download any media for ${params.url}`);
  }

  return {
    files,
    source: {
      kind: 'remote',
      originalInput: params.url,
      displayLabel: params.url,
      provider: 'instagram',
      canonicalUrl: `https://www.instagram.com/p/${shortcode}/`,
      title: `Instagram post ${shortcode}`,
    },
  };
}

function inferProvider(url: URL): RemoteProvider {
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'youtu.be' || hostname.endsWith('youtube.com')) {
    return 'youtube';
  }

  if (hostname.endsWith('instagram.com')) {
    return 'instagram';
  }

  throw new Error(`Unsupported URL provider: ${url.toString()}`);
}

function createRemoteSource(url: string, provider: RemoteProvider, metadata: YtDlpMetadata): SourceDescriptor {
  const canonicalUrl = metadata.webpage_url?.trim() || metadata.original_url?.trim() || url;
  const title = metadata.title?.trim();

  return {
    kind: 'remote',
    originalInput: url,
    displayLabel: title || canonicalUrl,
    provider,
    canonicalUrl,
    ...(title ? {title} : {}),
  };
}

export function isSupportedRemoteUrl(rawInput: string): boolean {
  try {
    const parsed = new URL(rawInput);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export async function resolveRemoteSource(params: {
  rawInput: string;
  paths: AppPaths;
  refresh?: boolean;
}): Promise<{source: SourceDescriptor; assetPaths: string[]}> {
  const parsed = new URL(params.rawInput);
  const provider = inferProvider(parsed);
  const sourceDir = getSourceDirectory(params.paths, provider, params.rawInput);

  if (params.refresh) {
    await rm(sourceDir, {recursive: true, force: true});
  }

  await ensureDir(sourceDir);

  const existingManifest = !params.refresh ? await readManifest(sourceDir) : undefined;
  if (existingManifest) {
    return {
      source: existingManifest.source,
      assetPaths: existingManifest.assetRelativePaths.map((relativePath) =>
        path.join(sourceDir, relativePath),
      ),
    };
  }

  const preferInstaloader = provider === 'instagram' && shouldPreferInstaloaderForInstagramUrl(params.rawInput);
  let source: SourceDescriptor;
  let assetPaths: string[];

  if (preferInstaloader) {
    try {
      const fallback = await downloadWithInstaloader({
        url: params.rawInput,
        sourceDir,
      });
      source = fallback.source;
      assetPaths = fallback.files;
    } catch {
      const metadata = await probeWithYtDlp(params.rawInput);
      source = createRemoteSource(params.rawInput, provider, metadata);
      if (provider === 'instagram' && !hasYtDlpMedia(metadata)) {
        const fallback = await downloadWithInstaloader({
          url: params.rawInput,
          sourceDir,
        });
        source = fallback.source;
        assetPaths = fallback.files;
      } else {
        assetPaths = await downloadWithYtDlp({
          url: params.rawInput,
          sourceDir,
          treatAsPlaylist: metadata._type === 'playlist',
        });
      }
    }
  } else {
    const metadata = await probeWithYtDlp(params.rawInput);
    source = createRemoteSource(params.rawInput, provider, metadata);
    if (provider === 'instagram' && !hasYtDlpMedia(metadata)) {
      const fallback = await downloadWithInstaloader({
        url: params.rawInput,
        sourceDir,
      });
      source = fallback.source;
      assetPaths = fallback.files;
    } else {
      assetPaths = await downloadWithYtDlp({
        url: params.rawInput,
        sourceDir,
        treatAsPlaylist: metadata._type === 'playlist',
      });
    }
  }

  await writeManifest(sourceDir, {
    source,
    assetRelativePaths: assetPaths.map((assetPath) => path.relative(sourceDir, assetPath)),
  });

  return {source, assetPaths};
}

export async function readRemoteManifest(rawInput: string, paths: AppPaths): Promise<DownloadManifest | undefined> {
  if (!isSupportedRemoteUrl(rawInput)) {
    return undefined;
  }

  const parsed = new URL(rawInput);
  const provider = inferProvider(parsed);
  const sourceDir = getSourceDirectory(paths, provider, rawInput);
  return await readManifest(sourceDir);
}

export async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}
