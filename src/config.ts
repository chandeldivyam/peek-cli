import path from 'node:path';
import {stat} from 'node:fs/promises';
import envPaths from 'env-paths';

import {ensureDir, readJsonFile, writeJsonAtomic} from './fs-utils.js';
import {APP_NAME} from './types.js';
import type {AppPaths} from './types.js';

interface AppConfig {
  apiKey?: string;
  updatedAt?: string;
}

export function getAppPaths(): AppPaths {
  const paths = envPaths(APP_NAME, {suffix: ''});
  return {
    configDir: paths.config,
    dataDir: paths.data,
    cacheDir: paths.cache,
    reportsDir: path.join(paths.cache, 'reports'),
    configFile: path.join(paths.config, 'config.json'),
    indexFile: path.join(paths.cache, 'index.json'),
  };
}

export async function ensureAppPaths(paths: AppPaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.configDir),
    ensureDir(paths.dataDir),
    ensureDir(paths.cacheDir),
    ensureDir(paths.reportsDir),
  ]);
}

export class ConfigStore {
  constructor(private readonly paths: AppPaths) {}

  async getApiKey(): Promise<string | undefined> {
    const envApiKey = process.env.GEMINI_API_KEY?.trim();
    if (envApiKey) {
      return envApiKey;
    }

    const config = await readJsonFile<AppConfig>(this.paths.configFile, {});
    return config.apiKey?.trim();
  }

  async saveApiKey(apiKey: string): Promise<void> {
    await writeJsonAtomic(
      this.paths.configFile,
      {
        apiKey,
        updatedAt: new Date().toISOString(),
      } satisfies AppConfig,
      0o600,
    );
  }

  async hasStoredApiKey(): Promise<boolean> {
    try {
      const info = await stat(this.paths.configFile);
      return info.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
}
