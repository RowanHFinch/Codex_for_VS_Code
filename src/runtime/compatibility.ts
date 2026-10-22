import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeClient } from './client';
import type { InitializeResponse } from '../protocol/InitializeResponse';
import { version as extensionVersion } from '../../package.json';
import { mcpFingerprint } from '../integrations';
import { realpath } from 'node:fs/promises';
import { within } from '../files';
import { runtimeSettings } from './settings';
import { runtimeExecutable } from './executable';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
export const TESTED_RUNTIME = '0.152.0';
/** Oldest app-server protocol this client was built against; newer releases are additive in practice. */
export const MINIMUM_RUNTIME = '0.152.0';
/** Numeric x.y.z comparison; prerelease suffixes (e.g. 0.162.0-alpha.1) count as that release. */
export function atLeast(version: string, minimum: string) {
  const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const [a, b] = [parse(version), parse(minimum)];
  if (a.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
export async function runtimeVersion(executable: string) {
  try {
    const { stdout } = await exec(runtimeExecutable(executable), ['--version'], {
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
    });
    const version = /^codex-cli (\S+)/m.exec(stdout)?.[1];
    if (!version || !atLeast(version, MINIMUM_RUNTIME))
      throw new Error(`Unsupported runtime. Install Codex ${MINIMUM_RUNTIME} or newer.`);
    return version;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unsupported runtime.')) throw error;
    throw new Error(
      `Codex not found. Install the official CLI (${MINIMUM_RUNTIME} or newer) or set Codex for VS Code: Runtime Path.`,
    );
  }
}

/**
 * With the default `codex`, also consider the CLIs bundled with the Codex and ChatGPT desktop apps (the
 * places Claudian searches) and use the newest, so a stale PATH install does not hide newer models.
 * An explicit Runtime Path setting is used as is.
 */
async function selectRuntime(executable: string, platform = process.platform, home = homedir()) {
  const candidates = [executable];
  if (executable === 'codex' && platform === 'darwin')
    candidates.push(
      ...['/Applications', join(home, 'Applications')]
        .flatMap(root => [
          join(root, 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
          join(root, 'Codex.app/Contents/Resources/codex'),
        ])
        .filter(path => existsSync(path)),
    );
  const versions = await Promise.allSettled(candidates.map(path => runtimeVersion(path)));
  let best: { executable: string; version: string } | undefined;
  for (const [index, result] of versions.entries()) {
    if (result.status !== 'fulfilled') continue;
    const version = result.value;
    if (!best || (atLeast(version, best.version) && !atLeast(best.version, version)))
      best = { executable: runtimeExecutable(candidates[index]), version };
  }
  if (!best) throw (versions[0] as PromiseRejectedResult).reason;
  return best;
}
export async function preferredRuntime(executable: string, platform = process.platform, home = homedir()) {
  if (executable !== 'codex' || platform !== 'darwin') return executable;
  return (await selectRuntime(executable, platform, home)).executable;
}
export async function connect(
  executable: string,
  cwd: string,
  mcpGrants: Record<string, string> = {},
  configurationOnly = false,
) {
  const selected = await selectRuntime(executable);
  executable = selected.executable;
  const version = selected.version;
  // Metadata connections create no thread. Thread policy belongs to the chosen workflow. Provider and
  // sign-in follow the user's own Codex configuration, as other Codex clients do.
  const args = ['app-server', '--listen', 'stdio://'];
  async function start(extra: string[]) {
    const client = RuntimeClient.spawn(executable, [...args, ...extra], cwd);
    try {
      const initialized = await client.request<InitializeResponse>('initialize', {
        clientInfo: { name: 'independent_codex_vscode', title: 'Codex for VS Code', version: extensionVersion },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      client.notify('initialized');
      const codexHome = await realpath(initialized.codexHome);
      if (within(cwd, codexHome) || within(codexHome, cwd))
        throw new Error(
          'Codex home and the workspace must use separate directories to protect runtime configuration and credentials.',
        );
      // With `cwd` the read includes the workspace's own `.codex/config.toml`; without it, project MCP
      // servers were invisible here and connected in every thread without a workspace grant.
      const { config } = await client.request<{ config: Record<string, any> }>('config/read', {
        includeLayers: false,
        cwd,
      });
      return { client, version, codexHome, config, policyArgs: extra };
    } catch (error) {
      client.stop();
      throw error;
    }
  }
  let connection = await start([]);
  const servers = Object.keys(connection.config.mcp_servers ?? {});
  const enabledMcp: string[] = [];
  // A configuration connection never creates threads or queries the global MCP manager.
  if (servers.length && !configurationOnly) {
    connection.client.stop();
    if (servers.some(name => !/^[A-Za-z0-9_-]+$/.test(name)))
      throw new Error('MCP server names cannot be safely overridden by this runtime version.');
    for (const name of servers) {
      const server = connection.config.mcp_servers[name];
      if (server.enabled !== false && mcpGrants[name] === mcpFingerprint(server)) enabledMcp.push(name);
    }
    connection = await start(
      servers.flatMap(name => ['-c', `mcp_servers.${name}.enabled=${enabledMcp.includes(name)}`]),
    );
    if (
      Object.entries(connection.config.mcp_servers ?? {}).some(
        ([name, server]: [string, any]) =>
          server.enabled !== enabledMcp.includes(name) ||
          (server.enabled && mcpGrants[name] !== mcpFingerprint(server)),
      ) ||
      enabledMcp.some(name => !connection.config.mcp_servers?.[name])
    ) {
      connection.client.stop();
      throw new Error('Cannot disable configured MCP servers safely.');
    }
  }
  return {
    client: connection.client,
    version,
    codexHome: connection.codexHome,
    policyArgs: connection.policyArgs,
    enabledMcp,
    settings: runtimeSettings(connection.config),
  };
}

/**
 * One configuration connection shared by a burst of requests (a write plus its readback), closed after
 * `idleMs` without users. Spawning a runtime per request cost two processes per refresh, including the
 * skills check before every send with a selected skill. A connection that dies or never opened is
 * replaced on next use; ordinary request errors keep it.
 */
export function sharedConnection<T extends { client: RuntimeClient }>(open: () => Promise<T>, idleMs = 2000) {
  let current: Promise<T> | undefined,
    users = 0,
    idle: NodeJS.Timeout | undefined;
  const alive = (connection: Promise<T>) =>
    connection.then(
      value => value.client.connected,
      () => false,
    );
  const close = (connection: Promise<T>) =>
    void connection.then(
      value => value.client.shutdown(),
      () => {},
    );
  return async <R>(work: (connection: T) => Promise<R>): Promise<R> => {
    clearTimeout(idle);
    users++;
    const seen = current;
    if (seen && !(await alive(seen)) && current === seen) {
      // Disconnected is not exited: a runtime with a broken pipe can keep running, so stop it too.
      current = undefined;
      close(seen);
    }
    const connection = (current ??= open());
    try {
      return await work(await connection);
    } catch (error) {
      if (current === connection && !(await alive(connection))) {
        current = undefined;
        close(connection);
      }
      throw error;
    } finally {
      if (--users === 0 && current) {
        const last = current;
        idle = setTimeout(() => {
          if (current === last && users === 0) {
            current = undefined;
            close(last);
          }
        }, idleMs);
        idle.unref();
      }
    }
  };
}
