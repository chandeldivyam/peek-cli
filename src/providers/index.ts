import {geminiProvider} from './gemini.js';
import {openRouterProvider} from './openrouter.js';
import {xaiProvider} from './xai.js';
import type {GenerationProviderId} from '../types.js';
import type {GenerationProvider} from './types.js';

const generationProviders: Record<GenerationProviderId, GenerationProvider> = {
  gemini: geminiProvider,
  xai: xaiProvider,
  openrouter: openRouterProvider,
};

export function getGenerationProvider(provider: GenerationProviderId): GenerationProvider {
  return generationProviders[provider];
}

export function parseGenerationProvider(value?: string): GenerationProviderId {
  const normalized = value?.trim().toLowerCase() || 'gemini';
  if (normalized === 'gemini' || normalized === 'xai' || normalized === 'openrouter') {
    return normalized;
  }

  throw new Error(`Unknown generation provider "${value}". Use "gemini", "xai", or "openrouter".`);
}

export function renderAgentHelp(topic: 'root' | 'create' | 'image' | 'video' = 'root'): string {
  const commandExamples = [
    'peek <file-or-url>',
    'peek analyze <file-or-url> --json',
    'peek ask <file-or-url> "What is happening here?"',
    'peek create image --provider gemini "A clean product poster"',
    'peek create image --provider xai --size 2k "A campaign visual"',
    'peek create video --provider xai --duration 10 --resolution 720p "A cinematic product shot"',
    'peek create video --provider openrouter --model bytedance/seedance-2.0-fast --duration 4 --resolution 480p "A kinetic product reveal"',
  ];

  const root = [
    'peek is a media analysis and generation CLI designed for agents.',
    '',
    'Primary workflows:',
    '- Analyze local image/video files or supported Instagram/YouTube URLs.',
    '- Ask follow-up questions against cached canonical reports.',
    '- Generate image/video assets through explicit providers.',
    '',
    'Rules for agents:',
    '- Pass `--json` when downstream tooling needs structured output.',
    '- Pass `--provider` for every `peek create` call.',
    '- Use `--output` when the generated asset path must be stable.',
    '- Prefer explicit model aliases before raw model IDs.',
    '',
    'Examples:',
    ...commandExamples.map((example) => `- ${example}`),
  ];

  const create = [
    'peek create generates image and video assets.',
    '',
    'Provider selection:',
    '- `--provider gemini` uses Gemini/Nano Banana for images and Veo for videos.',
    '- `--provider xai` uses Grok Imagine image and video models.',
    '- `--provider openrouter` uses OpenRouter video-generation models only.',
    '',
    'Authentication:',
    '- Gemini: set GEMINI_API_KEY or run `peek auth --provider gemini`.',
    '- xAI: set XAI_API_KEY or run `peek auth --provider xai`.',
    '- OpenRouter: set OPENROUTER_API_KEY or run `peek auth --provider openrouter`.',
    '',
    geminiProvider.getAgentHelp(),
    '',
    xaiProvider.getAgentHelp(),
    '',
    openRouterProvider.getAgentHelp(),
  ];

  const image = [
    'peek create image <prompt>',
    '',
    'Use for text-to-image or image editing.',
    'Common options: --provider, --model, --input, --count, --aspect-ratio, --size, --output, --json.',
    '',
    'Examples:',
    '- peek create image --provider gemini --model pro "Premium coffee campaign art" --output ./poster.jpg',
    '- peek create image --provider xai --size 2k --count 3 "Three fashion lookbook frames" --output ./frames',
    '- peek create image --provider xai --input ./ref.jpg "Render this as a pencil sketch"',
    '',
    'OpenRouter does not support image generation in peek.',
  ];

  const video = [
    'peek create video <prompt>',
    '',
    'Use for text-to-video, image-to-video, reference-guided video, or video extension.',
    'Common options: --provider, --model, --image, --reference, --video, --duration, --aspect-ratio, --resolution, --output, --json.',
    '',
    'Examples:',
    '- peek create video --provider gemini --model fast "A shoe rotating on a pedestal"',
    '- peek create video --provider xai --duration 10 --resolution 720p "A drone shot over a futuristic city"',
    '- peek create video --provider xai --image ./start.png "Animate this product packshot"',
    '- peek create video --provider openrouter --model bytedance/seedance-2.0 "A drone shot over a futuristic city"',
    '- peek create video --provider openrouter --model bytedance/seedance-2.0-fast --image ./start.png "Animate this product packshot"',
    '- peek create video --provider openrouter --model kwaivgi/kling-video-o1 --duration 5 "A cinematic street scene"',
  ];

  return {
    root,
    create,
    image,
    video,
  }[topic].join('\n');
}
