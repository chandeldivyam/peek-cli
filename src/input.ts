import {lstat, stat} from 'node:fs/promises';
import path from 'node:path';
import {lookup as lookupMime} from 'mime-types';

import {computeFileHash} from './fs-utils.js';
import type {ResolvedInputFile} from './types.js';

const extensionMimeMap = new Map<string, string>([
  ['.avi', 'video/x-msvideo'],
  ['.m4v', 'video/x-m4v'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
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

export async function resolveInputFile(rawPath: string): Promise<ResolvedInputFile> {
  const absolutePath = path.resolve(rawPath);
  const fileInfo = await lstat(absolutePath);
  if (fileInfo.isDirectory()) {
    throw new Error(
      `Directories are not supported in v1. Pass explicit video files instead: ${rawPath}`,
    );
  }
  if (!fileInfo.isFile()) {
    throw new Error(`Input is not a regular file: ${rawPath}`);
  }

  const mimeType = inferMimeType(absolutePath);
  if (!mimeType?.startsWith('video/')) {
    throw new Error(
      `Unsupported input format for ${rawPath}. peek v1 only accepts explicit video files.`,
    );
  }

  const fileStat = await stat(absolutePath);
  const hash = await computeFileHash(absolutePath);

  return {
    absolutePath,
    displayPath: path.relative(process.cwd(), absolutePath) || path.basename(absolutePath),
    sizeBytes: fileStat.size,
    modifiedTime: fileStat.mtime.toISOString(),
    mimeType,
    hash,
  };
}
