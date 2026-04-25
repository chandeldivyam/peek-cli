import path from 'node:path';
import {stat} from 'node:fs/promises';
import envPaths from 'env-paths';

import {ensureDir, readJsonFile, writeJsonAtomic} from './fs-utils.js';
import {APP_NAME} from './types.js';
import type {AppPaths} from './types.js';
import type {GenerationProviderId} from './types.js';

interface AppConfig {
  apiKeys?: Partial<Record<GenerationProviderId, string>>;
  apiKey?: string;
  updatedAt?: string;
}

const providerEnvVars: Record<GenerationProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export function getAppPaths(): AppPaths {
  const paths = envPaths(APP_NAME, {suffix: ''});
  return {
    configDir: paths.config,
    dataDir: paths.data,
    cacheDir: paths.cache,
    reportsDir: path.join(paths.cache, 'reports'),
    downloadsDir: path.join(paths.cache, 'downloads'),
    generationRecordsDir: path.join(paths.cache, 'generations'),
    configFile: path.join(paths.config, 'config.json'),
    indexFile: path.join(paths.cache, 'index.json'),
    generationIndexFile: path.join(paths.cache, 'generation-index.json'),
  };
}

export async function ensureAppPaths(paths: AppPaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.configDir),
    ensureDir(paths.dataDir),
    ensureDir(paths.cacheDir),
    ensureDir(paths.reportsDir),
    ensureDir(paths.downloadsDir),
    ensureDir(paths.generationRecordsDir),
  ]);
}

export class ConfigStore {
  constructor(private readonly paths: AppPaths) {}

  async getApiKey(): Promise<string | undefined> {
    return await this.getProviderApiKey('gemini');
  }

  async getProviderApiKey(provider: GenerationProviderId): Promise<string | undefined> {
    const envApiKey = process.env[providerEnvVars[provider]]?.trim();
    if (envApiKey) {
      return envApiKey;
    }

    const config = await readJsonFile<AppConfig>(this.paths.configFile, {});
    return (config.apiKeys?.[provider] ?? (provider === 'gemini' ? config.apiKey : undefined))?.trim();
  }

  async saveApiKey(apiKey: string): Promise<void> {
    await this.saveProviderApiKey('gemini', apiKey);
  }

  async saveProviderApiKey(provider: GenerationProviderId, apiKey: string): Promise<void> {
    const existing = await readJsonFile<AppConfig>(this.paths.configFile, {});
    await writeJsonAtomic(
      this.paths.configFile,
      {
        ...existing,
        apiKeys: {
          ...(existing.apiKeys ?? {}),
          [provider]: apiKey,
        },
        ...(provider === 'gemini' ? {apiKey} : {}),
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
