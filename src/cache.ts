import path from 'node:path';

import {
  ensureDir,
  hashString,
  readJsonFile,
  readTextFile,
  removeIfExists,
  writeFileAtomic,
  writeJsonAtomic,
} from './fs-utils.js';
import {
  INDEX_VERSION,
  PROMPT_VERSION,
  REPORT_SCHEMA_VERSION,
  canonicalReportSchema,
} from './types.js';
import type {
  AppPaths,
  CacheIndexEntry,
  CacheIndexFile,
  CanonicalReport,
  UploadedFileReference,
  WebMode,
} from './types.js';

function createEmptyIndex(): CacheIndexFile {
  return {version: INDEX_VERSION, entries: []};
}

export function buildCacheKey(params: {
  fileHash: string;
  model: string;
  webMode: WebMode;
}): string {
  return hashString(
    JSON.stringify({
      fileHash: params.fileHash,
      model: params.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: REPORT_SCHEMA_VERSION,
      webMode: params.webMode,
    }),
  );
}

export class CacheStore {
  constructor(private readonly paths: AppPaths) {}

  async getByCacheKey(cacheKey: string): Promise<{
    entry: CacheIndexEntry;
    report: CanonicalReport;
    renderedText: string;
  } | undefined> {
    const index = await this.readIndex();
    const entry = index.entries.find((candidate) => candidate.cacheKey === cacheKey);
    if (!entry) {
      return undefined;
    }

    try {
      const report = canonicalReportSchema.parse(
        await readJsonFile<unknown>(entry.reportPath, undefined),
      );
      const renderedText = await readTextFile(entry.textPath, '');
      return {entry, report, renderedText};
    } catch {
      return undefined;
    }
  }

  async getLatestByFileHash(fileHash: string): Promise<{
    entry: CacheIndexEntry;
    report: CanonicalReport;
    renderedText: string;
  } | undefined> {
    const index = await this.readIndex();
    const matchingEntries = index.entries
      .filter((candidate) => candidate.fileHash === fileHash)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    for (const entry of matchingEntries) {
      try {
        const report = canonicalReportSchema.parse(
          await readJsonFile<unknown>(entry.reportPath, undefined),
        );
        const renderedText = await readTextFile(entry.textPath, '');
        return {entry, report, renderedText};
      } catch {
        continue;
      }
    }

    return undefined;
  }

  async store(params: {
    cacheKey: string;
    fileHash: string;
    filePath: string;
    model: string;
    webMode: WebMode;
    report: CanonicalReport;
    renderedText: string;
    uploadedFile?: UploadedFileReference;
  }): Promise<CacheIndexEntry> {
    await ensureDir(this.paths.reportsDir);

    const reportPath = path.join(this.paths.reportsDir, `${params.cacheKey}.json`);
    const textPath = path.join(this.paths.reportsDir, `${params.cacheKey}.txt`);
    const now = new Date().toISOString();

    await Promise.all([
      writeJsonAtomic(reportPath, params.report),
      writeFileAtomic(textPath, params.renderedText),
    ]);

    const index = await this.readIndex();
    const existingEntry = index.entries.find(
      (candidate) => candidate.cacheKey === params.cacheKey,
    );

    const nextEntry: CacheIndexEntry = {
      cacheKey: params.cacheKey,
      fileHash: params.fileHash,
      filePath: params.filePath,
      reportPath,
      textPath,
      model: params.model,
      webMode: params.webMode,
      schemaVersion: REPORT_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      createdAt: existingEntry?.createdAt ?? now,
      updatedAt: now,
      ...(params.uploadedFile ? {uploadedFile: params.uploadedFile} : {}),
    };

    const filteredEntries = index.entries.filter(
      (candidate) => candidate.cacheKey !== params.cacheKey,
    );
    filteredEntries.push(nextEntry);
    await this.writeIndex({version: INDEX_VERSION, entries: filteredEntries});

    return nextEntry;
  }

  async clearAll(): Promise<void> {
    const index = await this.readIndex();
    for (const entry of index.entries) {
      await Promise.all([removeIfExists(entry.reportPath), removeIfExists(entry.textPath)]);
    }
    await writeJsonAtomic(this.paths.indexFile, createEmptyIndex());
  }

  async clearByFileHash(fileHash: string): Promise<number> {
    const index = await this.readIndex();
    const matching = index.entries.filter((entry) => entry.fileHash === fileHash);
    for (const entry of matching) {
      await Promise.all([removeIfExists(entry.reportPath), removeIfExists(entry.textPath)]);
    }
    const remaining = index.entries.filter((entry) => entry.fileHash !== fileHash);
    await this.writeIndex({version: INDEX_VERSION, entries: remaining});
    return matching.length;
  }

  private async readIndex(): Promise<CacheIndexFile> {
    const raw = await readJsonFile<CacheIndexFile>(this.paths.indexFile, createEmptyIndex());
    if (raw.version !== INDEX_VERSION || !Array.isArray(raw.entries)) {
      return createEmptyIndex();
    }
    return raw;
  }

  private async writeIndex(index: CacheIndexFile): Promise<void> {
    await writeJsonAtomic(this.paths.indexFile, index);
  }
}
