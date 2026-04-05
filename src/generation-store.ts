import path from 'node:path';

import {
  ensureDir,
  readJsonFile,
  writeJsonAtomic,
} from './fs-utils.js';
import {GENERATION_INDEX_VERSION} from './types.js';
import type {
  AppPaths,
  GenerationIndexEntry,
  GenerationIndexFile,
  GenerationRecord,
} from './types.js';

function createEmptyIndex(): GenerationIndexFile {
  return {version: GENERATION_INDEX_VERSION, entries: []};
}

export class GenerationStore {
  constructor(private readonly paths: AppPaths) {}

  async store(record: GenerationRecord): Promise<GenerationIndexEntry> {
    await ensureDir(this.paths.generationRecordsDir);

    const recordPath = path.join(this.paths.generationRecordsDir, `${record.id}.json`);
    await writeJsonAtomic(recordPath, record);

    const index = await this.readIndex();
    const nextEntry: GenerationIndexEntry = {
      id: record.id,
      kind: record.kind,
      mode: record.mode,
      createdAt: record.createdAt,
      model: record.model,
      ...(record.modelAlias ? {modelAlias: record.modelAlias} : {}),
      prompt: record.prompt,
      recordPath,
      outputPaths: record.outputs.map((output) => output.path),
    };

    const remaining = index.entries.filter((entry) => entry.id !== record.id);
    remaining.push(nextEntry);
    await writeJsonAtomic(this.paths.generationIndexFile, {
      version: GENERATION_INDEX_VERSION,
      entries: remaining.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    } satisfies GenerationIndexFile);

    return nextEntry;
  }

  async get(id: string): Promise<GenerationRecord | undefined> {
    const index = await this.readIndex();
    const entry = index.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      return undefined;
    }

    return await readJsonFile<GenerationRecord | undefined>(entry.recordPath, undefined);
  }

  private async readIndex(): Promise<GenerationIndexFile> {
    const raw = await readJsonFile<GenerationIndexFile>(
      this.paths.generationIndexFile,
      createEmptyIndex(),
    );
    if (raw.version !== GENERATION_INDEX_VERSION || !Array.isArray(raw.entries)) {
      return createEmptyIndex();
    }

    return raw;
  }
}
