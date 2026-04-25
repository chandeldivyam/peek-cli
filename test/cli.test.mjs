import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

test('CLI version comes from package.json', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const {stdout} = await execFileAsync('node', ['dist/cli.js', '--version']);

  assert.equal(stdout.trim(), packageJson.version);
});

test('bare auth command advertises provider selection without defaulting in help', async () => {
  const {stdout} = await execFileAsync('node', ['dist/cli.js', 'auth', '--help']);

  assert.match(stdout, /--provider <provider>/);
  assert.match(stdout, /openrouter/);
  assert.doesNotMatch(stdout, /default: "gemini"/);
});

test('video create help advertises OpenRouter as a provider', async () => {
  const {stdout} = await execFileAsync('node', ['dist/cli.js', 'create', 'video', '--help']);

  assert.match(stdout, /openrouter/);
});

test('agent help includes OpenRouter video examples', async () => {
  const {stdout} = await execFileAsync('node', ['dist/cli.js', '--agent-help']);

  assert.match(stdout, /--provider openrouter/);
  assert.match(stdout, /bytedance\/seedance-2\.0-fast/);
});
