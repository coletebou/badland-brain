/**
 * Run the built command (dist/cli.js) the way a user does: a real process, settings from the environment, a real
 * MongoDB, a real port. `npm run test:e2e` builds first.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export function assertBuilt(): void {
  if (!existsSync(CLI)) {
    throw new Error('dist/cli.js is missing: run `npm run build` (npm run test:e2e does it for you)');
  }
}

export interface CliResult { code: number | null; stdout: string; stderr: string }

/** Run one command to completion. `input` is written to its stdin. */
export function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/** Start `serve` and wait for its listening line; resolves with the URL it printed. */
export function startServe(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; url: string; logs: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    const timer = setTimeout(() => reject(new Error(`serve did not start in time:\n${logs}`)), 60_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
      for (const line of logs.split('\n')) {
        try {
          const event = JSON.parse(line) as { msg?: string; url?: string };
          if (event.msg === 'badland-brain listening' && event.url) {
            clearTimeout(timer);
            resolve({ child, url: event.url, logs: () => logs });
            return;
          }
        } catch {
          // not a complete JSON line yet
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited with ${code}:\n${logs}`));
    });
  });
}

export async function stopServe(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
}

export async function mcpClient(url: string, key: string): Promise<Client> {
  const client = new Client({ name: 'e2e-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

/** A tool call's structured result; throws with the tool's own error text when it failed. */
export async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(JSON.stringify(result.content));
  }
  return result.structuredContent as T;
}

/** A tool call that must fail; resolves with its error text. */
export async function toolError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      return JSON.stringify(result.content);
    }
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error(`${name} unexpectedly succeeded`);
}
