import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  chmod,
} from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, {recursive: true});
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function readTextFile(filePath: string, fallback = ''): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function writeFileAtomic(
  filePath: string,
  contents: string,
  mode?: number,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, contents, mode ? {mode} : undefined);
  if (mode !== undefined) {
    await chmod(tempPath, mode);
  }
  await rename(tempPath, filePath);
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function computeFileHash(filePath: string): Promise<string> {
  await stat(filePath);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export async function removeIfExists(filePath: string): Promise<void> {
  await rm(filePath, {force: true});
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
