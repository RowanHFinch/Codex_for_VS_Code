import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { lstat, realpath, readdir, mkdir, writeFile } from 'node:fs/promises';
import { DeliveryError } from './runtime/client';
import type { ConfigLayer } from './protocol/v2/ConfigLayer';
import type { SkillsListResponse } from './protocol/v2/SkillsListResponse';
import type { SkillsConfigWriteResponse } from './protocol/v2/SkillsConfigWriteResponse';
import type { ListMcpServerStatusResponse } from './protocol/v2/ListMcpServerStatusResponse';
import type { SkillMetadata } from './protocol/v2/SkillMetadata';
import type { IntegrationState, EcosystemState } from './shared';

export type IntegrationRpc = { request<T>(method: string, params?: unknown): Promise<T> };
type Server = { name: string; config: Record<string, any>; version: string; file: string; editable: boolean };
type ConfigRead = { config: Record<string, any>; layers: ConfigLayer[] | null };
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const id = (value: string) => createHash('sha256').update(value).digest('hex');
export function mcpFingerprint(config: Record<string, any>): string {
  const ordered = (value: any): any =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map(k => [k, ordered(value[k])]),
          )
        : value;
  const { enabled, ...settings } = config;
  return id(JSON.stringify(ordered(settings)));
}
export class Integrations {
  state: IntegrationState = { skills: [], servers: [], loading: false, uncertain: false };
  ecosystem: EcosystemState = { features: [], hooks: [], plugins: [], agents: [], loading: false };
  private hooks = new Map<string, any>();
  private plugins = new Map<string, any>();
  private files = new Map<string, string>();
  private skills = new Map<string, SkillMetadata>();
  private servers = new Map<string, Server>();
  private user?: { file: string; version: string };
  private revision = 0;
  constructor(
    private rpc: IntegrationRpc,
    private root: string,
    private codexHome: string,
    private grants: () => Record<string, string>,
    private guard: () => void,
    private changed: () => void,
    private beforeWrite: () => Promise<void> = async () => {},
    private writer: IntegrationRpc = rpc,
  ) {}
  async refresh(threadId?: string, catalogRpc = this.rpc) {
    this.guard();
    const revision = ++this.revision;
    this.state.loading = true;
    this.changed();
    try {
      const [listed, configuration] = await Promise.all([
        catalogRpc.request<SkillsListResponse>('skills/list', { cwds: [this.root], forceReload: true }),
        catalogRpc.request<ConfigRead>('config/read', { includeLayers: true, cwd: this.root }),
      ]);
      this.guard();
      if (revision !== this.revision) return;
      const skills = new Map<string, SkillMetadata>();
      for (const entry of listed.data)
        if ((await realpath(entry.cwd)) === this.root)
          for (const skill of entry.skills)
            if (typeof skill.name === 'string' && typeof skill.path === 'string' && basename(skill.path) === 'SKILL.md')
              skills.set(id(skill.path + '\0' + skill.name), skill);
      const skillChoices = [...skills].map(([id, s]) => ({
        id,
        name: s.name,
        description: (s.interface?.shortDescription || s.description).slice(0, 1000),
        scope: s.scope,
        enabled: s.enabled,
      }));
      const layers = (configuration.layers ?? []).filter(l => !l.disabledReason && l.name.type !== 'sessionFlags');
      const user = layers.find(l => l.name.type === 'user' && l.name.profile === null);
      const userConfig =
        user?.name.type === 'user' && resolve(user.name.file) === resolve(this.codexHome, 'config.toml')
          ? { file: user.name.file, version: user.version }
          : undefined;
      const names = new Set(layers.flatMap(l => Object.keys(object(object(l.config).mcp_servers))));
      const servers = new Map<string, Server>();
      for (const name of names) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) continue;
        const provider = layers.find(l => object(object(l.config).mcp_servers)[name] !== undefined)!;
        const config = { ...object(configuration.config.mcp_servers?.[name]) };
        const setting = layers.find(l => object(object(object(l.config).mcp_servers)[name]).enabled !== undefined);
        config.enabled = setting ? object(object(object(setting.config).mcp_servers)[name]).enabled !== false : true;
        const editable = provider === user && Boolean(userConfig);
        servers.set(id(name + '\0' + provider.version), {
          name,
          config,
          editable,
          file: editable ? userConfig!.file : '',
          version: provider.version,
        });
      }
      let runtime: ListMcpServerStatusResponse['data'] = [],
        cursor: string | null = null;
      const cursors = new Set<string>();
      // An unscoped status query creates the runtime's global MCP manager; inspect only a real thread.
      while (threadId) {
        const page: ListMcpServerStatusResponse = await this.rpc.request('mcpServerStatus/list', {
          threadId: threadId ?? null,
          cursor,
          limit: 100,
          detail: 'toolsAndAuthOnly',
        });
        runtime.push(...page.data);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('MCP inventory pagination did not advance.');
        if (cursor) cursors.add(cursor);
        if (!cursor) break;
      }
      const serverChoices = [...servers].map(([key, s]) => {
        const live = runtime.find(r => r.name === s.name);
        return {
          id: key,
          name: s.name,
          transport: typeof s.config.url === 'string' ? 'HTTP' : 'stdio',
          scope: s.editable ? 'user' : 'managed/project',
          enabled: s.config.enabled !== false,
          allowed: this.grants()[s.name] === mcpFingerprint(s.config),
          status: live?.runtimeStatus ?? 'notConnected',
          auth: live?.authStatus ?? 'unknown',
          tools: Object.keys(live?.tools ?? {}).slice(0, 100),
          editable: s.editable,
        };
      });
      this.guard();
      if (revision !== this.revision) return;
      // Publish the authoritative maps and their UI projection together after every async read.
      this.skills = skills;
      this.servers = servers;
      this.user = userConfig;
      this.state.skills = skillChoices;
      this.state.servers = serverChoices;
      this.state.uncertain = false;
      this.state.notice = listed.data.some(e => e.errors.length)
        ? 'Some skills could not be loaded. Open the Skills files to correct their metadata.'
        : undefined;
    } catch (error) {
      if (revision === this.revision) this.state.uncertain = true;
      throw error;
    } finally {
      if (revision === this.revision) {
        this.state.loading = false;
        this.changed();
      }
    }
  }
  skill(id: string) {
    const skill = this.skills.get(id);
    if (!skill) throw new Error('Skill inventory changed. Refresh and choose again.');
    return skill;
  }
  server(id: string) {
    const server = this.servers.get(id);
    if (!server) throw new Error('MCP configuration changed. Refresh and choose again.');
    return server;
  }
  private writable() {
    this.guard();
    if (this.state.uncertain || this.state.loading)
      throw new Error('Refresh integrations before changing configuration.');
  }
  private async write(operation: () => Promise<unknown>) {
    this.writable();
    try {
      await this.beforeWrite();
      this.writable();
      return await operation();
    } catch (error) {
      if (error instanceof DeliveryError && error.delivery === 'unknown') this.state.uncertain = true;
      this.changed();
      throw error;
    }
  }
  async toggleSkill(key: string, enabled: boolean) {
    const skill = this.skill(key);
    await this.write(async () => {
      const result = await this.writer.request<SkillsConfigWriteResponse>('skills/config/write', {
        path: skill.path,
        enabled,
      });
      if (result.effectiveEnabled !== enabled) throw new Error('Skill state is overridden by policy.');
    });
    await this.refresh(undefined, this.writer);
    if (this.skill(key).enabled !== enabled)
      throw new Error('Skill setting did not take effect. Refresh before retrying.');
  }
  async selected(ids: string[]) {
    await this.refresh(undefined, this.writer);
    return ids.map(key => {
      const skill = this.skill(key);
      if (!skill.enabled) throw new Error('A selected skill is disabled. Remove it or enable it first.');
      return { name: skill.name, path: skill.path };
    });
  }
  private async safeConfig(file: string, allowMissing = false) {
    this.guard();
    if (resolve(file) !== resolve(this.codexHome, 'config.toml'))
      throw new Error('Only the Codex user configuration can be changed here.');
    if ((await realpath(this.codexHome)) !== this.codexHome)
      throw new Error('Linked Codex home is not writable through this panel.');
    let stat;
    try {
      stat = await lstat(file);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (await realpath(file)) !== file)
      throw new Error('Linked configuration files are not writable through this panel.');
  }
  async changeServer(key: string, enabled: boolean | null) {
    const server = this.server(key);
    if (!server.editable)
      throw new Error('This server is managed by a project or administrator. Open its configuration instead.');
    await this.safeConfig(server.file);
    await this.write(() =>
      this.writer.request('config/value/write', {
        keyPath: `mcp_servers.${server.name}${enabled === null ? '' : '.enabled'}`,
        value: enabled,
        mergeStrategy: 'replace',
        filePath: server.file,
        expectedVersion: server.version,
      }),
    );
    await this.refresh(undefined, this.writer);
    const observed = this.state.servers.find(s => s.name === server.name);
    if (enabled === null ? Boolean(observed) : observed?.enabled !== enabled)
      throw new Error('MCP setting is overridden or did not take effect. Refresh configuration.');
    return server;
  }
  async addServer(name: string, config: Record<string, unknown>) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name) || this.state.servers.some(s => s.name === name))
      throw new Error('Choose a new MCP server name using letters, numbers, hyphens and underscores.');
    if (!this.user) await this.refresh();
    if (!this.user) throw new Error('The user configuration is managed or unavailable.');
    // Let the runtime create a missing file using its observed missing-file version and atomic writer.
    await this.safeConfig(this.user.file, true);
    await this.write(() =>
      this.writer.request('config/value/write', {
        keyPath: `mcp_servers.${name}`,
        value: { ...config, enabled: false },
        mergeStrategy: 'replace',
        filePath: this.user!.file,
        expectedVersion: this.user!.version,
      }),
    );
    await this.refresh(undefined, this.writer);
    if (!this.state.servers.some(s => s.name === name && !s.enabled))
      throw new Error('New MCP configuration could not be verified.');
  }
  async refreshEcosystem(rpc = this.rpc) {
    this.guard();
    this.ecosystem.loading = true;
    this.changed();
    try {
      const [hooks, plugins, features] = await Promise.all([
        rpc.request<any>('hooks/list', { cwds: [this.root] }),
        rpc.request<any>('plugin/installed', { cwds: [this.root] }),
        rpc.request<any>('experimentalFeature/list', { limit: 100 }),
      ]);
      this.hooks.clear();
      this.plugins.clear();
      this.files.clear();
      this.ecosystem.hooks = hooks.data.flatMap((entry: any) =>
        entry.hooks.map((h: any) => {
          const key = id(h.key + '\0' + h.currentHash);
          this.hooks.set(key, h);
          this.files.set(key, h.sourcePath);
          return {
            id: key,
            event: h.eventName,
            source: h.source,
            enabled: h.enabled,
            managed: h.isManaged,
            supported: ['command', 'mcpTool'].includes(h.handlerType),
            trust: h.trustStatus,
          };
        }),
      );
      this.ecosystem.plugins = plugins.marketplaces.flatMap((market: any) =>
        market.plugins.map((p: any) => {
          const key = id(p.id);
          this.plugins.set(key, {
            ...p,
            marketplacePath: market.path,
            remoteMarketplaceName: market.path ? null : market.name,
          });
          return {
            id: key,
            name: p.interface?.displayName ?? p.name,
            description: (p.interface?.shortDescription ?? '').slice(0, 1000),
            enabled: p.enabled,
            installed: p.installed,
          };
        }),
      );
      this.ecosystem.features = features.data
        .filter((f: any) => ['hooks', 'plugins', 'multi_agent', 'memories'].includes(f.name))
        .map((f: any) => ({ name: f.name, enabled: f.enabled }));
      this.ecosystem.agents = [];
      for (const [directory, scope] of [
        [join(this.codexHome, 'agents'), 'user'],
        [join(this.root, '.codex', 'agents'), 'project'],
      ]) {
        let names: string[];
        try {
          if ((await realpath(directory)) !== directory) continue;
          names = await readdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        for (const name of names.filter(n => /^[A-Za-z0-9_-]+\.toml$/.test(n)).slice(0, 100)) {
          const file = join(directory, name),
            stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
          const key = id(file);
          this.files.set(key, file);
          this.ecosystem.agents.push({ id: key, name: name.slice(0, -5), scope });
        }
      }
      this.ecosystem.notice =
        hooks.data.some((e: any) => e.errors?.length || e.warnings?.length) || plugins.marketplaceLoadErrors?.length
          ? 'Some native ecosystem entries could not be loaded. Check their original configuration.'
          : undefined;
    } finally {
      this.ecosystem.loading = false;
      this.changed();
    }
  }
  file(key: string) {
    const file = this.files.get(key);
    if (!file) throw new Error('Configuration entry expired. Refresh first.');
    return file;
  }
  hook(key: string) {
    const hook = this.hooks.get(key);
    if (!hook || hook.isManaged || !['command', 'mcpTool'].includes(hook.handlerType))
      throw new Error('This hook is managed, unsupported or expired.');
    return hook;
  }
  plugin(key: string) {
    const plugin = this.plugins.get(key);
    if (!plugin) throw new Error('Plugin entry expired.');
    return plugin;
  }
  private async writeUser(edits: { keyPath: string; value: unknown; mergeStrategy: 'upsert' | 'replace' }[]) {
    if (!this.user) await this.refresh();
    if (!this.user) throw new Error('User configuration is managed or unavailable.');
    await this.safeConfig(this.user.file, true);
    await this.write(async () => {
      const result = await this.writer.request<{ status: string }>('config/batchWrite', {
        edits,
        filePath: this.user!.file,
        expectedVersion: this.user!.version,
        reloadUserConfig: true,
      });
      if (result.status !== 'ok')
        throw new Error('Configuration was overridden or could not be confirmed. Refresh before retrying.');
    });
    await this.refresh(undefined, this.writer);
    await this.refreshEcosystem(this.writer);
  }
  async feature(name: string, enabled: boolean) {
    if (!this.ecosystem.features.some(f => f.name === name))
      throw new Error('This feature is unavailable in the runtime.');
    await this.writeUser([{ keyPath: `features.${name}`, value: enabled, mergeStrategy: 'upsert' }]);
    if (this.ecosystem.features.find(f => f.name === name)?.enabled !== enabled)
      throw new Error('Feature setting did not take effect.');
  }
  async changeHook(key: string, enabled: boolean, trust = false) {
    const hook = this.hook(key),
      setting = `hooks.state.${JSON.stringify(hook.key)}`;
    await this.writeUser([
      { keyPath: `${setting}.enabled`, value: enabled, mergeStrategy: 'upsert' },
      ...(trust
        ? [{ keyPath: `${setting}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'upsert' as const }]
        : []),
    ]);
    const observed = this.ecosystem.hooks.find(h => h.id === key);
    if (!observed || observed.enabled !== enabled || (trust && observed.trust !== 'trusted'))
      throw new Error('Hook changed or its setting was overridden. Review it again.');
  }
  async changePlugin(key: string, enabled: boolean) {
    const plugin = this.plugin(key);
    await this.writeUser([
      { keyPath: `plugins.${JSON.stringify(plugin.id)}.enabled`, value: enabled, mergeStrategy: 'upsert' },
    ]);
    if (this.ecosystem.plugins.find(p => p.id === key)?.enabled !== enabled)
      throw new Error('Plugin setting did not take effect.');
  }
  async availablePlugins() {
    const result = await this.rpc.request<any>('plugin/list', { cwds: [this.root], forceRefetch: true });
    return result.marketplaces.flatMap((market: any) =>
      market.plugins
        .filter((p: any) => !p.installed && p.availability === 'AVAILABLE')
        .map((p: any) => ({
          label: p.interface?.displayName ?? p.name,
          description: p.interface?.shortDescription ?? '',
          pluginName: p.name,
          marketplacePath: market.path,
          remoteMarketplaceName: market.path ? null : market.name,
        })),
    );
  }
  async installPlugin(choice: {
    pluginName: string;
    marketplacePath: string | null;
    remoteMarketplaceName: string | null;
  }) {
    await this.write(() => this.writer.request('plugin/install', choice));
    await this.refresh(undefined, this.writer);
    await this.refreshEcosystem(this.writer);
    if (![...this.plugins.values()].some(p => p.name === choice.pluginName && p.installed))
      throw new Error('Plugin installation could not be confirmed.');
  }
  async removePlugin(key: string) {
    const plugin = this.plugin(key);
    await this.write(() => this.writer.request('plugin/uninstall', { pluginId: plugin.id }));
    await this.refresh(undefined, this.writer);
    await this.refreshEcosystem(this.writer);
    if (this.ecosystem.plugins.some(p => p.id === key && p.installed))
      throw new Error('Plugin removal could not be confirmed.');
  }
  async addAgent(name: string) {
    this.writable();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new Error('Use an agent name with 1–64 letters, numbers, hyphens or underscores.');
    await this.beforeWrite();
    this.writable();
    const base = join(this.root, '.codex'),
      directory = join(base, 'agents');
    for (const path of [base, directory]) {
      await mkdir(path, { recursive: false }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      if ((await realpath(path)) !== path) throw new Error('Linked agent directories are not writable here.');
    }
    const file = join(directory, `${name}.toml`);
    this.guard();
    await writeFile(
      file,
      `name = "${name}"\ndescription = "Describe when to use this agent."\ndeveloper_instructions = "Describe this agent's task and constraints."\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await this.refreshEcosystem();
    return file;
  }
  get configPath() {
    return join(this.codexHome, 'config.toml');
  }
}
