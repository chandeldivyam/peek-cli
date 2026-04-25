import type {ImageCreateRequest, VideoCreateRequest} from '../generation.js';
import type {GenerationProviderId, MediaKind} from '../types.js';

export interface ProgressReporter {
  (message: string): void;
}

export interface GeneratedBinaryOutput {
  bytes: Buffer;
  mimeType: string;
  kind: MediaKind;
}

export interface GeneratedVideoOutput {
  operationName?: string;
  mimeType: string;
  usage?: {
    cost?: number;
    isByok?: boolean;
    raw: unknown;
  };
}

export interface GenerationProvider {
  id: GenerationProviderId;
  label: string;
  envVar: string;
  defaultImageModel: string;
  defaultVideoModel: string;
  resolveImageModel(input?: string): {model: string; alias?: string};
  resolveVideoModel(input?: string): {model: string; alias?: string};
  validateImageRequest(request: ImageCreateRequest): void;
  validateVideoRequest(request: VideoCreateRequest): void;
  createClient(apiKey: string): GenerationProviderClient;
  getAgentHelp(): string;
}

export interface GenerationProviderClient {
  generateImages(params: {
    request: ImageCreateRequest;
    onProgress?: ProgressReporter;
  }): Promise<GeneratedBinaryOutput[]>;
  generateVideo(params: {
    request: VideoCreateRequest;
    outputPath: string;
    onProgress?: ProgressReporter;
  }): Promise<GeneratedVideoOutput>;
}
