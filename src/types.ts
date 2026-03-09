import {z} from 'zod';

export const APP_NAME = 'peek';
export const DEFAULT_MODEL = 'gemini-3-flash-preview';
export const API_KEY_VALIDATION_MODEL = DEFAULT_MODEL;
export const REPORT_SCHEMA_VERSION = 1;
export const PROMPT_VERSION = '2026-03-09-v1';
export const INDEX_VERSION = 1;

export const webModeSchema = z.enum(['enabled', 'disabled']);
export type WebMode = z.infer<typeof webModeSchema>;

export const fileDescriptorSchema = z.object({
  path: z.string(),
  hash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string(),
  modifiedTime: z.string(),
});
export type FileDescriptor = z.infer<typeof fileDescriptorSchema>;

export const chapterSchema = z.object({
  start: z.string(),
  end: z.string().optional(),
  title: z.string(),
  description: z.string(),
});

export const personSchema = z.object({
  name: z.string(),
  role: z.string(),
  evidence: z.string().optional(),
});

export const analysisPayloadSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  detailedOverview: z.string(),
  chapters: z.array(chapterSchema).min(1),
  people: z.array(personSchema),
  locations: z.array(z.string()),
  objects: z.array(z.string()),
  brands: z.array(z.string()),
  onScreenText: z.array(z.string()),
  audioSummary: z.string(),
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
  file: fileDescriptorSchema,
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

export interface CacheIndexEntry {
  cacheKey: string;
  fileHash: string;
  filePath: string;
  reportPath: string;
  textPath: string;
  model: string;
  webMode: WebMode;
  schemaVersion: number;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
  uploadedFile?: UploadedFileReference;
}

export interface CacheIndexFile {
  version: number;
  entries: CacheIndexEntry[];
}

export interface ResolvedInputFile {
  absolutePath: string;
  displayPath: string;
  sizeBytes: number;
  modifiedTime: string;
  mimeType: string;
  hash: string;
}

export interface AnalyzeOptions {
  model: string;
  webMode: WebMode;
  refresh: boolean;
}

export interface AnalyzeResult {
  report: CanonicalReport;
  uploadedFile?: UploadedFileReference;
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
  configFile: string;
  indexFile: string;
}

export const analysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'headline',
    'summary',
    'detailedOverview',
    'chapters',
    'people',
    'locations',
    'objects',
    'brands',
    'onScreenText',
    'audioSummary',
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
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'title', 'description'],
        properties: {
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
