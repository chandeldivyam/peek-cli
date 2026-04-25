import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildImageCreateRequest,
  buildVideoCreateRequest,
  planOutputAssets,
  resolveImageModelChoice,
  resolveVideoModelChoice,
} from '../dist/generation.js';
import {GenerationStore} from '../dist/generation-store.js';
import {getGenerationProvider} from '../dist/providers/index.js';

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'peek-gen-test-'));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
}

function createAsset(kind, filePath, mimeType) {
  return {
    index: 0,
    kind,
    absolutePath: filePath,
    displayPath: path.basename(filePath),
    sizeBytes: 123,
    modifiedTime: '2026-04-05T00:00:00.000Z',
    mimeType,
    hash: `${kind}-hash`,
  };
}

function createSource(rawInput, assets) {
  return {
    rawInput,
    source: {
      kind: 'local',
      originalInput: rawInput,
      displayLabel: rawInput,
      title: path.basename(rawInput),
    },
    assets,
  };
}

test('resolveImageModelChoice maps aliases to Nano Banana models', () => {
  assert.equal(resolveImageModelChoice('flash').model, 'gemini-3.1-flash-image-preview');
  assert.equal(resolveImageModelChoice('pro').model, 'gemini-3-pro-image-preview');
});

test('resolveImageModelChoice maps xAI image aliases', () => {
  assert.equal(resolveImageModelChoice('xai', 'imagine').model, 'grok-imagine-image');
  assert.equal(resolveImageModelChoice('xai').model, 'grok-imagine-image');
});

test('resolveVideoModelChoice maps aliases to Veo models', () => {
  assert.equal(resolveVideoModelChoice('fast').model, 'veo-3.1-fast-generate-preview');
  assert.equal(resolveVideoModelChoice('quality').model, 'veo-3.1-generate-preview');
  assert.equal(resolveVideoModelChoice('lite').model, 'veo-3.1-lite-generate-preview');
});

test('resolveVideoModelChoice maps xAI video aliases', () => {
  assert.equal(resolveVideoModelChoice('xai', 'imagine').model, 'grok-imagine-video');
  assert.equal(resolveVideoModelChoice('xai').model, 'grok-imagine-video');
});

test('planOutputAssets uses a direct file path for a single explicit output file', () => {
  const outputs = planOutputAssets({
    kind: 'image',
    count: 1,
    mimeTypes: ['image/jpeg'],
    outputPath: '/tmp/result.jpg',
    prompt: 'red square',
  });

  assert.deepEqual(outputs, [
    {
      index: 0,
      path: '/tmp/result.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
    },
  ]);
});

test('planOutputAssets creates numbered files inside a directory for multiple outputs', () => {
  const outputs = planOutputAssets({
    kind: 'image',
    count: 2,
    mimeTypes: ['image/jpeg', 'image/png'],
    outputPath: '/tmp/peek-images',
    prompt: 'red square',
  });

  assert.deepEqual(outputs, [
    {
      index: 0,
      path: '/tmp/peek-images/image-001.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
    },
    {
      index: 1,
      path: '/tmp/peek-images/image-002.png',
      kind: 'image',
      mimeType: 'image/png',
    },
  ]);
});

test('buildImageCreateRequest rejects non-image generation inputs', () => {
  assert.throws(
    () =>
      buildImageCreateRequest({
        prompt: 'make this prettier',
        inputSources: [
          createSource('/tmp/video.mp4', [createAsset('video', '/tmp/video.mp4', 'video/mp4')]),
        ],
      }),
    /only image assets/,
  );
});

test('buildVideoCreateRequest rejects unsupported lite reference mode', () => {
  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        model: 'lite',
        prompt: 'animate this',
        referenceSources: [
          createSource('/tmp/ref.png', [createAsset('image', '/tmp/ref.png', 'image/png')]),
        ],
      });
      getGenerationProvider('gemini').validateVideoRequest(request);
    },
    /does not support reference images/,
  );
});

test('xAI provider validates its video limits', () => {
  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'xai',
        prompt: 'animate this',
        referenceSources: [],
        resolution: '1080p',
      });
      getGenerationProvider('xai').validateVideoRequest(request);
    },
    /480p or 720p/,
  );
});

test('buildVideoCreateRequest rejects last-frame without image', () => {
  assert.throws(
    () =>
      buildVideoCreateRequest({
        prompt: 'animate this',
        lastFrameSource: createSource('/tmp/last.png', [
          createAsset('image', '/tmp/last.png', 'image/png'),
        ]),
        referenceSources: [],
      }),
    /requires `--image`/,
  );
});

test('GenerationStore persists and reloads generation records', async () => {
  await withTempDir(async (tempDir) => {
    const paths = {
      configDir: tempDir,
      dataDir: tempDir,
      cacheDir: tempDir,
      reportsDir: path.join(tempDir, 'reports'),
      downloadsDir: path.join(tempDir, 'downloads'),
      generationRecordsDir: path.join(tempDir, 'generations'),
      configFile: path.join(tempDir, 'config.json'),
      indexFile: path.join(tempDir, 'index.json'),
      generationIndexFile: path.join(tempDir, 'generation-index.json'),
    };
    const store = new GenerationStore(paths);

    await store.store({
      id: 'gen-1',
      provider: 'gemini',
      kind: 'image',
      mode: 'prompt',
      createdAt: '2026-04-05T00:00:00.000Z',
      model: 'gemini-3.1-flash-image-preview',
      prompt: 'red square',
      inputs: [],
      outputs: [
        {
          index: 0,
          kind: 'image',
          path: '/tmp/output.jpg',
          hash: 'abc',
          sizeBytes: 10,
          mimeType: 'image/jpeg',
          createdAt: '2026-04-05T00:00:00.000Z',
        },
      ],
      options: {count: 1},
    });

    const loaded = await store.get('gen-1');
    assert.equal(loaded?.prompt, 'red square');
    assert.equal(loaded?.provider, 'gemini');
    assert.equal(loaded?.outputs[0]?.path, '/tmp/output.jpg');
  });
});
