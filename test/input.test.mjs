import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {buildCacheKey} from '../dist/cache.js';
import {resolveInputBundle} from '../dist/input.js';
import {
  shouldPreferInstaloaderForInstagramUrl,
  sortMediaFilePaths,
} from '../dist/remote.js';

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'peek-test-'));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
}

test('resolveInputBundle classifies a local image file as an image asset bundle', async () => {
  await withTempDir(async (tempDir) => {
    const imagePath = path.join(tempDir, 'sample.jpg');
    await writeFile(imagePath, 'image-bytes');

    const bundle = await resolveInputBundle({
      rawInput: imagePath,
      paths: {
        configDir: tempDir,
        dataDir: tempDir,
        cacheDir: tempDir,
        reportsDir: tempDir,
        downloadsDir: tempDir,
        configFile: path.join(tempDir, 'config.json'),
        indexFile: path.join(tempDir, 'index.json'),
      },
    });

    assert.equal(bundle.assets.length, 1);
    assert.equal(bundle.assets[0].kind, 'image');
    assert.equal(bundle.source.kind, 'local');
  });
});

test('resolveInputBundle classifies a local video file as a video asset bundle', async () => {
  await withTempDir(async (tempDir) => {
    const videoPath = path.join(tempDir, 'sample.mp4');
    await writeFile(videoPath, 'video-bytes');

    const bundle = await resolveInputBundle({
      rawInput: videoPath,
      paths: {
        configDir: tempDir,
        dataDir: tempDir,
        cacheDir: tempDir,
        reportsDir: tempDir,
        downloadsDir: tempDir,
        configFile: path.join(tempDir, 'config.json'),
        indexFile: path.join(tempDir, 'index.json'),
      },
    });

    assert.equal(bundle.assets.length, 1);
    assert.equal(bundle.assets[0].kind, 'video');
    assert.equal(bundle.source.kind, 'local');
  });
});

test('buildCacheKey changes when sourceHash changes', () => {
  const first = buildCacheKey({
    sourceHash: 'hash-a',
    model: 'gemini-3-flash-preview',
    webMode: 'enabled',
  });
  const second = buildCacheKey({
    sourceHash: 'hash-b',
    model: 'gemini-3-flash-preview',
    webMode: 'enabled',
  });

  assert.notEqual(first, second);
});

test('Instagram feed posts prefer the Instaloader path while reels do not', () => {
  assert.equal(
    shouldPreferInstaloaderForInstagramUrl('https://www.instagram.com/p/DWrypmlkXKM/'),
    true,
  );
  assert.equal(
    shouldPreferInstaloaderForInstagramUrl('https://www.instagram.com/reels/DSzu-VrjCdX/'),
    false,
  );
  assert.equal(
    shouldPreferInstaloaderForInstagramUrl('https://www.youtube.com/shorts/SJT-eFH4Zs0'),
    false,
  );
});

test('sortMediaFilePaths keeps numbered carousel assets in numeric order', () => {
  const sorted = sortMediaFilePaths([
    '/tmp/2026-04-03_21-15-18_UTC_10.jpg',
    '/tmp/2026-04-03_21-15-18_UTC_2.mp4',
    '/tmp/2026-04-03_21-15-18_UTC_1.jpg',
    '/tmp/2026-04-03_21-15-18_UTC_11.jpg',
  ]);

  assert.deepEqual(sorted, [
    '/tmp/2026-04-03_21-15-18_UTC_1.jpg',
    '/tmp/2026-04-03_21-15-18_UTC_2.mp4',
    '/tmp/2026-04-03_21-15-18_UTC_10.jpg',
    '/tmp/2026-04-03_21-15-18_UTC_11.jpg',
  ]);
});
