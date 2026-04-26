import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
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
import {getGenerationProvider, parseGenerationProvider} from '../dist/providers/index.js';
import {
  buildOpenAiImageEditFormData,
  buildOpenAiImageGenerationBody,
} from '../dist/providers/openai.js';
import {buildOpenRouterVideoRequestBody} from '../dist/providers/openrouter.js';

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

test('resolveImageModelChoice maps OpenAI image model', () => {
  assert.equal(resolveImageModelChoice('openai').model, 'gpt-image-2');
  assert.equal(resolveImageModelChoice('openai', 'gpt-image-2').model, 'gpt-image-2');
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

test('parseGenerationProvider accepts OpenRouter and OpenAI', () => {
  assert.equal(parseGenerationProvider('openrouter'), 'openrouter');
  assert.equal(parseGenerationProvider('OpenRouter'), 'openrouter');
  assert.equal(parseGenerationProvider('openai'), 'openai');
  assert.equal(parseGenerationProvider('OpenAI'), 'openai');
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

test('OpenAI provider validates image model and output controls', () => {
  assert.throws(
    () => {
      const request = buildImageCreateRequest({
        provider: 'openai',
        model: 'gpt-image-1',
        prompt: 'make a poster',
        inputSources: [],
      });
      getGenerationProvider('openai').validateImageRequest(request);
    },
    /only gpt-image-2/,
  );

  assert.throws(
    () => {
      const request = buildImageCreateRequest({
        provider: 'openai',
        prompt: 'make a poster',
        background: 'transparent',
        inputSources: [],
      });
      getGenerationProvider('openai').validateImageRequest(request);
    },
    /does not support transparent backgrounds/,
  );

  assert.throws(
    () => {
      const request = buildImageCreateRequest({
        provider: 'openai',
        prompt: 'make a poster',
        outputCompression: 50,
        inputSources: [],
      });
      getGenerationProvider('openai').validateImageRequest(request);
    },
    /requires `--output-format jpeg`/,
  );

  assert.throws(
    () => {
      const request = buildImageCreateRequest({
        provider: 'openai',
        prompt: 'make a poster',
        imageSize: '1025x1024',
        inputSources: [],
      });
      getGenerationProvider('openai').validateImageRequest(request);
    },
    /multiples of 16/,
  );
});

test('buildOpenAiImageGenerationBody maps prompt request and output controls', () => {
  const request = buildImageCreateRequest({
    provider: 'openai',
    prompt: 'make a poster',
    quality: 'low',
    outputFormat: 'jpeg',
    outputCompression: 50,
    background: 'opaque',
    moderation: 'low',
    inputSources: [],
  });
  getGenerationProvider('openai').validateImageRequest(request);

  assert.deepEqual(buildOpenAiImageGenerationBody(request), {
    model: 'gpt-image-2',
    prompt: 'make a poster',
    n: 1,
    size: '1024x1024',
    quality: 'low',
    output_format: 'jpeg',
    output_compression: 50,
    background: 'opaque',
    moderation: 'low',
  });
});

test('buildOpenAiImageGenerationBody maps aspect ratios to OpenAI sizes', () => {
  const request = buildImageCreateRequest({
    provider: 'openai',
    prompt: 'make a poster',
    aspectRatio: '16:9',
    inputSources: [],
  });
  getGenerationProvider('openai').validateImageRequest(request);

  assert.equal(buildOpenAiImageGenerationBody(request).size, '1536x864');
});

test('buildOpenAiImageEditFormData maps input images', async () => {
  await withTempDir(async (tempDir) => {
    const refPath = path.join(tempDir, 'ref.png');
    await writeFile(refPath, 'ref-bytes');

    const request = buildImageCreateRequest({
      provider: 'openai',
      prompt: 'polish this image',
      inputSources: [
        createSource(refPath, [createAsset('image', refPath, 'image/png')]),
      ],
    });
    const form = await buildOpenAiImageEditFormData(request);
    const entries = Array.from(form.entries());

    assert.equal(entries.find(([key]) => key === 'model')?.[1], 'gpt-image-2');
    assert.equal(entries.find(([key]) => key === 'prompt')?.[1], 'polish this image');
    assert.equal(entries.find(([key]) => key === 'size')?.[1], '1024x1024');
    const imageEntry = entries.find(([key]) => key === 'image[]');
    assert.ok(imageEntry);
    assert.notEqual(typeof imageEntry[1], 'string');
  });
});

test('OpenAI image client decodes b64_json and preserves usage', async () => {
  const originalFetch = globalThis.fetch;
  const request = buildImageCreateRequest({
    provider: 'openai',
    prompt: 'make a poster',
    outputFormat: 'webp',
    inputSources: [],
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [{b64_json: Buffer.from('RIFFxxxxWEBPimage-bytes').toString('base64')}],
        usage: {total_tokens: 7},
      }),
      {status: 200, headers: {'content-type': 'application/json'}},
    );

  try {
    const outputs = await getGenerationProvider('openai').createClient('test-key').generateImages({request});
    assert.equal(outputs[0]?.bytes.toString(), 'RIFFxxxxWEBPimage-bytes');
    assert.equal(outputs[0]?.mimeType, 'image/webp');
    assert.deepEqual(outputs[0]?.usage?.raw, {total_tokens: 7});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI image client detects actual PNG bytes when format differs', async () => {
  const originalFetch = globalThis.fetch;
  const request = buildImageCreateRequest({
    provider: 'openai',
    prompt: 'make a poster',
    outputFormat: 'webp',
    inputSources: [],
  });
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('png-bytes'),
  ]);

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [{b64_json: pngBytes.toString('base64')}],
      }),
      {status: 200, headers: {'content-type': 'application/json'}},
    );

  try {
    const outputs = await getGenerationProvider('openai').createClient('test-key').generateImages({request});
    assert.equal(outputs[0]?.mimeType, 'image/png');
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('OpenRouter rejects ByteDance Seed text model for video', () => {
  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'bytedance-seed/seed-2.0-mini',
        prompt: 'animate this',
        referenceSources: [],
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /not an OpenRouter video-generation model/,
  );
});

test('OpenRouter Seedance validates duration, resolution, and aspect ratio', () => {
  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'bytedance/seedance-2.0',
        prompt: 'animate this',
        referenceSources: [],
        durationSeconds: 16,
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /between 4 and 15/,
  );

  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'animate this',
        referenceSources: [],
        resolution: '1080p',
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /480p, 720p/,
  );

  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'bytedance/seedance-2.0',
        prompt: 'animate this',
        referenceSources: [],
        aspectRatio: '3:2',
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /aspect ratio/,
  );
});

test('OpenRouter Kling validates unsupported options', () => {
  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'kwaivgi/kling-video-o1',
        prompt: 'animate this',
        referenceSources: [],
        durationSeconds: 4,
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /duration/,
  );

  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'kwaivgi/kling-video-o1',
        prompt: 'animate this',
        referenceSources: [],
        resolution: '480p',
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /resolution/,
  );

  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'kwaivgi/kling-video-o1',
        prompt: 'animate this',
        referenceSources: [],
        aspectRatio: '4:3',
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /aspect ratio/,
  );

  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'kwaivgi/kling-video-o1',
        prompt: 'animate this',
        referenceSources: [
          createSource('/tmp/ref.png', [createAsset('image', '/tmp/ref.png', 'image/png')]),
        ],
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /does not support `--reference`/,
  );

  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'kwaivgi/kling-video-o1',
        prompt: 'animate this',
        referenceSources: [],
        seed: 123,
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /does not support `--seed`/,
  );

  assert.throws(
    () => {
      const request = buildVideoCreateRequest({
        provider: 'openrouter',
        model: 'kwaivgi/kling-video-o1',
        prompt: 'animate this',
        referenceSources: [],
        videoSource: createSource('/tmp/video.mp4', [
          createAsset('video', '/tmp/video.mp4', 'video/mp4'),
        ]),
      });
      getGenerationProvider('openrouter').validateVideoRequest(request);
    },
    /does not support `--video` extension/,
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

test('buildOpenRouterVideoRequestBody maps frame image inputs', async () => {
  await withTempDir(async (tempDir) => {
    const startPath = path.join(tempDir, 'start.png');
    const endPath = path.join(tempDir, 'end.png');
    await writeFile(startPath, 'start-bytes');
    await writeFile(endPath, 'end-bytes');

    const request = buildVideoCreateRequest({
      provider: 'openrouter',
      model: 'bytedance/seedance-2.0',
      prompt: 'move from start to end',
      imageSource: createSource(startPath, [createAsset('image', startPath, 'image/png')]),
      lastFrameSource: createSource(endPath, [createAsset('image', endPath, 'image/png')]),
      referenceSources: [],
    });
    const body = await buildOpenRouterVideoRequestBody(request);

    assert.equal(body.model, 'bytedance/seedance-2.0');
    assert.equal(body.prompt, 'move from start to end');
    assert.deepEqual(body.frame_images.map((image) => image.frame_type), [
      'first_frame',
      'last_frame',
    ]);
    assert.match(body.frame_images[0].image_url.url, /^data:image\/png;base64,/);
  });
});

test('buildOpenRouterVideoRequestBody maps reference inputs', async () => {
  await withTempDir(async (tempDir) => {
    const refPath = path.join(tempDir, 'ref.jpg');
    await writeFile(refPath, 'ref-bytes');

    const request = buildVideoCreateRequest({
      provider: 'openrouter',
      model: 'bytedance/seedance-2.0-fast',
      prompt: 'keep this style',
      referenceSources: [
        createSource(refPath, [createAsset('image', refPath, 'image/jpeg')]),
      ],
      seed: 42,
    });
    const body = await buildOpenRouterVideoRequestBody(request);

    assert.equal(body.seed, 42);
    assert.equal(body.input_references.length, 1);
    assert.match(body.input_references[0].image_url.url, /^data:image\/jpeg;base64,/);
  });
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
      usage: {
        cost: 0.25,
        isByok: false,
        raw: {cost: 0.25, is_byok: false},
      },
      options: {count: 1},
    });

    const loaded = await store.get('gen-1');
    assert.equal(loaded?.prompt, 'red square');
    assert.equal(loaded?.provider, 'gemini');
    assert.equal(loaded?.outputs[0]?.path, '/tmp/output.jpg');
    assert.equal(loaded?.usage?.cost, 0.25);
  });
});
