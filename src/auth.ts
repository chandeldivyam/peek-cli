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

export async function ensureApiKey(params: {
  configStore: ConfigStore;
  forcePrompt?: boolean;
}): Promise<string> {
  if (!params.forcePrompt) {
    const existingApiKey = await params.configStore.getApiKey();
    if (existingApiKey) {
      return existingApiKey;
    }
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'No GEMINI_API_KEY found. Run this command in an interactive terminal or set GEMINI_API_KEY.',
    );
  }

  intro('peek authentication');
  const enteredValue = await password({
    message: 'Enter your GEMINI_API_KEY',
    validate(value) {
      if (!value?.trim()) {
        return 'GEMINI_API_KEY is required.';
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
  progress.start('Verifying API key with Google Gen AI');
  try {
    const gemini = new GeminiService(apiKey);
    await gemini.verifyApiKey();
    progress.stop('API key verified');
    await params.configStore.saveApiKey(apiKey);
    log.success('Saved GEMINI_API_KEY to the local peek config directory.');
    outro('peek is ready.');
    return apiKey;
  } catch (error) {
    progress.error('API key verification failed');
    throw error;
  }
}
