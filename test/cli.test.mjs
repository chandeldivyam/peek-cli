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
  assert.doesNotMatch(stdout, /default: "gemini"/);
});
