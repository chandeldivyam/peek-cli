import {spawn} from 'node:child_process';

interface RunCommandOptions {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, options.args ?? [], {
      cwd: options.cwd,
      env: {...process.env, ...options.env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({stdout, stderr});
        return;
      }

      const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}`;
      reject(new Error(`${command} failed: ${detail}`));
    });
  });
}

export async function hasCommand(command: string): Promise<boolean> {
  try {
    await runCommand('which', {args: [command]});
    return true;
  } catch {
    return false;
  }
}
