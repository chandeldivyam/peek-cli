import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = 'chandeldivyam/peek-cli';
const DEFAULT_PREFIX = path.join(os.homedir(), '.local');

function resolveCliFilePath(): string {
  return fileURLToPath(import.meta.url);
}

function inferPrefixFromCliPath(cliPath: string): string | undefined {
  const normalized = path.resolve(cliPath);
  const marker = `${path.sep}lib${path.sep}node_modules${path.sep}peek${path.sep}dist${path.sep}`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }
  return normalized.slice(0, markerIndex);
}

function resolveInstallPrefix(): string {
  const envPrefix = process.env.PEEK_PREFIX?.trim();
  if (envPrefix) {
    return path.resolve(envPrefix);
  }

  const inferredPrefix = inferPrefixFromCliPath(resolveCliFilePath());
  if (inferredPrefix) {
    return inferredPrefix;
  }

  return DEFAULT_PREFIX;
}

function resolveReleaseTarballUrl(version?: string): string {
  const repo = process.env.PEEK_REPO?.trim() || DEFAULT_REPO;
  if (version?.trim()) {
    return `https://github.com/${repo}/releases/download/${version.trim()}/peek.tgz`;
  }
  return `https://github.com/${repo}/releases/latest/download/peek.tgz`;
}

export interface SelfUpdateResult {
  prefix: string;
  tarballUrl: string;
  versionLabel: string;
}

export async function installLatestRelease(version?: string): Promise<SelfUpdateResult> {
  const prefix = resolveInstallPrefix();
  const tarballUrl = resolveReleaseTarballUrl(version);
  await execFileAsync(
    'npm',
    ['install', '--global', '--silent', '--prefix', prefix, tarballUrl],
    {
      env: process.env,
    },
  );

  return {
    prefix,
    tarballUrl,
    versionLabel: version?.trim() || 'latest',
  };
}
