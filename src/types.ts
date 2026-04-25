import {z} from 'zod';

export const APP_NAME = 'peek';
export const DEFAULT_MODEL = 'gemini-3-flash-preview';
export const API_KEY_VALIDATION_MODEL = DEFAULT_MODEL;
export const REPORT_SCHEMA_VERSION = 2;
export const PROMPT_VERSION = '2026-04-05-v2';
export const INDEX_VERSION = 1;
export const GENERATION_INDEX_VERSION = 1;

export const webModeSchema = z.enum(['enabled', 'disabled']);
export type WebMode = z.infer<typeof webModeSchema>;

export const sourceKindSchema = z.enum(['local', 'remote']);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const remoteProviderSchema = z.enum(['instagram', 'youtube']);
export type RemoteProvider = z.infer<typeof remoteProviderSchema>;

export const mediaKindSchema = z.enum(['image', 'video']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const generationProviderSchema = z.enum(['gemini', 'xai', 'openrouter']);
export type GenerationProviderId = z.infer<typeof generationProviderSchema>;

export const generationKindSchema = z.enum(['image', 'video']);
export type GenerationKind = z.infer<typeof generationKindSchema>;

export const generationModeSchema = z.enum([
  'prompt',
  'edit',
  'image-to-video',
  'interpolation',
  'reference',
  'extension',
]);
export type GenerationMode = z.infer<typeof generationModeSchema>;

export const sourceDescriptorSchema = z.object({
  kind: sourceKindSchema,
  originalInput: z.string(),
  displayLabel: z.string(),
  title: z.string().optional(),
  provider: remoteProviderSchema.optional(),
  canonicalUrl: z.string().optional(),
});
export type SourceDescriptor = z.infer<typeof sourceDescriptorSchema>;

export const assetDescriptorSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: mediaKindSchema,
  path: z.string(),
  hash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string(),
  modifiedTime: z.string(),
});
export type AssetDescriptor = z.infer<typeof assetDescriptorSchema>;

export const segmentSchema = z.object({
  assetIndex: z.number().int().nonnegative(),
  start: z.string().optional(),
  end: z.string().optional(),
  title: z.string(),
  description: z.string(),
});
export type Segment = z.infer<typeof segmentSchema>;

export const assetSummarySchema = z.object({
  assetIndex: z.number().int().nonnegative(),
  summary: z.string(),
});
export type AssetSummary = z.infer<typeof assetSummarySchema>;

export const personSchema = z.object({
  name: z.string(),
  role: z.string(),
  evidence: z.string().optional(),
});

export const analysisPayloadSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  detailedOverview: z.string(),
  assetSummaries: z.array(assetSummarySchema).min(1),
  segments: z.array(segmentSchema).min(1),
  people: z.array(personSchema),
  locations: z.array(z.string()),
  objects: z.array(z.string()),
  brands: z.array(z.string()),
  onScreenText: z.array(z.string()),
  audioSummary: z.string().optional(),
  notableQuotes: z.array(z.string()),
  notableMoments: z.array(z.string()),
  themes: z.array(z.string()),
  webInsights: z.array(z.string()),
  uncertainties: z.array(z.string()),
  suggestedFollowUps: z.array(z.string()),
});
export type AnalysisPayload = z.infer<typeof analysisPayloadSchema>;

export const sourceSchema = z.object({
  title: z.string(),
  url: z.string(),
  publisher: z.string().optional(),
  query: z.string().optional(),
});
export type ReportSource = z.infer<typeof sourceSchema>;

export const canonicalReportSchema = z.object({
  generatedAt: z.string(),
  model: z.string(),
  schemaVersion: z.number().int(),
  promptVersion: z.string(),
  webMode: webModeSchema,
  source: sourceDescriptorSchema,
  assets: z.array(assetDescriptorSchema).min(1),
  analysis: analysisPayloadSchema,
  sources: z.array(sourceSchema),
  searchQueries: z.array(z.string()),
});
export type CanonicalReport = z.infer<typeof canonicalReportSchema>;

export interface UploadedFileReference {
  name: string;
  uri: string;
  mimeType: string;
  expirationTime?: string;
}

export interface UploadedAssetReference {
  assetHash: string;
  uploadedFile: UploadedFileReference;
}

export interface CacheIndexEntry {
  cacheKey: string;
  sourceHash: string;
  sourceInput: string;
  reportPath: string;
  textPath: string;
  model: string;
  webMode: WebMode;
  schemaVersion: number;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
  uploadedAssets?: UploadedAssetReference[];
}

export interface CacheIndexFile {
  version: number;
  entries: CacheIndexEntry[];
}

export interface ResolvedAsset {
  index: number;
  kind: MediaKind;
  absolutePath: string;
  displayPath: string;
  sizeBytes: number;
  modifiedTime: string;
  mimeType: string;
  hash: string;
}

export interface ResolvedInputBundle {
  source: SourceDescriptor;
  assets: ResolvedAsset[];
  sourceHash: string;
}

export interface AnalyzeOptions {
  model: string;
  webMode: WebMode;
  refresh: boolean;
}

export interface AnalyzeResult {
  report: CanonicalReport;
  uploadedAssets?: UploadedAssetReference[];
}

export interface AnswerResult {
  answer: string;
  sources: ReportSource[];
  searchQueries: string[];
}

export interface AppPaths {
  configDir: string;
  dataDir: string;
  cacheDir: string;
  reportsDir: string;
  downloadsDir: string;
  generationRecordsDir: string;
  configFile: string;
  indexFile: string;
  generationIndexFile: string;
}

export interface GeneratedOutputAsset {
  index: number;
  kind: MediaKind;
  path: string;
  hash: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

export interface GenerationInputSource {
  source: SourceDescriptor;
  assets: Array<{
    index: number;
    kind: MediaKind;
    path: string;
    hash: string;
    sizeBytes: number;
    mimeType: string;
    modifiedTime: string;
  }>;
}

export interface GenerationRecord {
  id: string;
  provider: GenerationProviderId;
  kind: GenerationKind;
  mode: GenerationMode;
  createdAt: string;
  model: string;
  modelAlias?: string;
  prompt: string;
  inputs: GenerationInputSource[];
  outputs: GeneratedOutputAsset[];
  options: Record<string, boolean | number | string | string[] | undefined>;
  operationName?: string;
  usage?: {
    cost?: number;
    isByok?: boolean;
    raw: unknown;
  };
}

export interface GenerationIndexEntry {
  id: string;
  provider: GenerationProviderId;
  kind: GenerationKind;
  mode: GenerationMode;
  createdAt: string;
  model: string;
  modelAlias?: string;
  prompt: string;
  recordPath: string;
  outputPaths: string[];
}

export interface GenerationIndexFile {
  version: number;
  entries: GenerationIndexEntry[];
}

export const analysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'headline',
    'summary',
    'detailedOverview',
    'assetSummaries',
    'segments',
    'people',
    'locations',
    'objects',
    'brands',
    'onScreenText',
    'notableQuotes',
    'notableMoments',
    'themes',
    'webInsights',
    'uncertainties',
    'suggestedFollowUps',
  ],
  properties: {
    headline: {type: 'string'},
    summary: {type: 'string'},
    detailedOverview: {type: 'string'},
    assetSummaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['assetIndex', 'summary'],
        properties: {
          assetIndex: {type: 'integer'},
          summary: {type: 'string'},
        },
      },
    },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['assetIndex', 'title', 'description'],
        properties: {
          assetIndex: {type: 'integer'},
          start: {type: 'string'},
          end: {type: 'string'},
          title: {type: 'string'},
          description: {type: 'string'},
        },
      },
    },
    people: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role'],
        properties: {
          name: {type: 'string'},
          role: {type: 'string'},
          evidence: {type: 'string'},
        },
      },
    },
    locations: {type: 'array', items: {type: 'string'}},
    objects: {type: 'array', items: {type: 'string'}},
    brands: {type: 'array', items: {type: 'string'}},
    onScreenText: {type: 'array', items: {type: 'string'}},
    audioSummary: {type: 'string'},
    notableQuotes: {type: 'array', items: {type: 'string'}},
    notableMoments: {type: 'array', items: {type: 'string'}},
    themes: {type: 'array', items: {type: 'string'}},
    webInsights: {type: 'array', items: {type: 'string'}},
    uncertainties: {type: 'array', items: {type: 'string'}},
    suggestedFollowUps: {type: 'array', items: {type: 'string'}},
  },
} as const;
