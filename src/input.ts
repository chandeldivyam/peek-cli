import {lstat, stat} from 'node:fs/promises';
import path from 'node:path';
import {lookup as lookupMime} from 'mime-types';

import {computeFileHash, hashString} from './fs-utils.js';
import {resolveRemoteSource, isSupportedRemoteUrl} from './remote.js';
import type {
  AppPaths,
  MediaKind,
  ResolvedAsset,
  ResolvedInputBundle,
  SourceDescriptor,
} from './types.js';

const extensionMimeMap = new Map<string, string>([
  ['.avi', 'video/x-msvideo'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.m4v', 'video/x-m4v'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
]);

function inferMimeType(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  const mapped = extensionMimeMap.get(extension);
  if (mapped) {
    return mapped;
  }

  const detected = lookupMime(filePath);
  return typeof detected === 'string' ? detected : undefined;
}

function inferMediaKind(mimeType: string): MediaKind | undefined {
  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  return undefined;
}

async function resolveAssetFromPath(filePath: string, index: number): Promise<ResolvedAsset> {
  const absolutePath = path.resolve(filePath);
  const fileInfo = await lstat(absolutePath);
  if (fileInfo.isDirectory()) {
    throw new Error(`Directories are not supported. Pass an explicit file instead: ${filePath}`);
  }
  if (!fileInfo.isFile()) {
    throw new Error(`Input is not a regular file: ${filePath}`);
  }

  const mimeType = inferMimeType(absolutePath);
  const kind = mimeType ? inferMediaKind(mimeType) : undefined;
  if (!mimeType || !kind) {
    throw new Error(
      `Unsupported input format for ${filePath}. peek accepts image and video files.`,
    );
  }

  const fileStat = await stat(absolutePath);
  const hash = await computeFileHash(absolutePath);

  return {
    index,
    kind,
    absolutePath,
    displayPath: path.relative(process.cwd(), absolutePath) || path.basename(absolutePath),
    sizeBytes: fileStat.size,
    modifiedTime: fileStat.mtime.toISOString(),
    mimeType,
    hash,
  };
}

function buildSourceHash(source: SourceDescriptor, assets: ResolvedAsset[]): string {
  const sourceIdentity =
    source.kind === 'remote' ? source.canonicalUrl ?? source.originalInput : source.originalInput;

  return hashString(
    JSON.stringify({
      source: {
        kind: source.kind,
        identity: sourceIdentity,
        provider: source.provider,
      },
      assets: assets.map((asset) => ({
        index: asset.index,
        kind: asset.kind,
        hash: asset.hash,
      })),
    }),
  );
}

async function resolveLocalInputBundle(rawInput: string): Promise<ResolvedInputBundle> {
  const asset = await resolveAssetFromPath(rawInput, 0);
  const source: SourceDescriptor = {
    kind: 'local',
    originalInput: rawInput,
    displayLabel: asset.displayPath,
    title: path.basename(asset.absolutePath),
  };

  return {
    source,
    assets: [asset],
    sourceHash: buildSourceHash(source, [asset]),
  };
}

async function resolveRemoteInputBundle(
  rawInput: string,
  paths: AppPaths,
  refresh = false,
): Promise<ResolvedInputBundle> {
  const remote = await resolveRemoteSource({rawInput, paths, refresh});
  const assets = await Promise.all(
    remote.assetPaths.map((assetPath, index) => resolveAssetFromPath(assetPath, index)),
  );

  return {
    source: remote.source,
    assets,
    sourceHash: buildSourceHash(remote.source, assets),
  };
}

export async function resolveInputBundle(params: {
  rawInput: string;
  paths: AppPaths;
  refresh?: boolean;
}): Promise<ResolvedInputBundle> {
  if (isSupportedRemoteUrl(params.rawInput)) {
    return await resolveRemoteInputBundle(params.rawInput, params.paths, params.refresh ?? false);
  }

  return await resolveLocalInputBundle(params.rawInput);
}
