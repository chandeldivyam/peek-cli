import {
  cancel,
  intro,
  isCancel,
  log,
  outro,
  password,
  spinner,
} from '@clack/prompts';

import {ConfigStore} from './config.js';
import {GeminiService} from './gemini.js';
import type {GenerationProviderId} from './types.js';

const providerEnvVars: Record<GenerationProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
};

const providerLabels: Record<GenerationProviderId, string> = {
  gemini: 'Google Gen AI',
  xai: 'xAI',
};

async function verifyProviderApiKey(provider: GenerationProviderId, apiKey: string): Promise<void> {
  if (provider === 'gemini') {
    const gemini = new GeminiService(apiKey);
    await gemini.verifyApiKey();
    return;
  }

  const response = await fetch('https://api.x.ai/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`xAI API key verification failed (${response.status}): ${detail}`);
  }
}

export async function ensureApiKey(params: {
  configStore: ConfigStore;
  forcePrompt?: boolean;
}): Promise<string> {
  return await ensureProviderApiKey({
    ...params,
    provider: 'gemini',
  });
}

export async function ensureProviderApiKey(params: {
  configStore: ConfigStore;
  provider: GenerationProviderId;
  forcePrompt?: boolean;
}): Promise<string> {
  if (!params.forcePrompt) {
    const existingApiKey = await params.configStore.getProviderApiKey(params.provider);
    if (existingApiKey) {
      return existingApiKey;
    }
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `No ${providerEnvVars[params.provider]} found. Run this command in an interactive terminal or set ${providerEnvVars[params.provider]}.`,
    );
  }

  intro('peek authentication');
  const enteredValue = await password({
    message: `Enter your ${providerEnvVars[params.provider]}`,
    validate(value) {
      if (!value?.trim()) {
        return `${providerEnvVars[params.provider]} is required.`;
      }
      return;
    },
  });

  if (isCancel(enteredValue)) {
    cancel('Authentication cancelled.');
    process.exit(1);
  }

  const apiKey = enteredValue.trim();
  const progress = spinner();
  progress.start(`Verifying API key with ${providerLabels[params.provider]}`);
  try {
    await verifyProviderApiKey(params.provider, apiKey);
    progress.stop('API key verified');
    await params.configStore.saveProviderApiKey(params.provider, apiKey);
    log.success(`Saved ${providerEnvVars[params.provider]} to the local peek config directory.`);
    outro('peek is ready.');
    return apiKey;
  } catch (error) {
    progress.error('API key verification failed');
    throw error;
  }
}
