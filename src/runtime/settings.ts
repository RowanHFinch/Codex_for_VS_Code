import type { AskForApproval } from '../protocol/v2/AskForApproval';
import type { ApprovalsReviewer } from '../protocol/v2/ApprovalsReviewer';

export type RuntimeSettings = {
  model?: string;
  effort?: string;
  profile: string;
  approval: AskForApproval;
  reviewer: ApprovalsReviewer;
  memories: boolean;
  /** Configured `model_provider`; history and resumes are scoped to it. */
  provider: string;
  /** Configured MCP server names, so restricted threads can switch each one off. */
  mcpServers: string[];
};
export const restrictedConfig = {
  'features.hooks': false,
  'features.plugins': false,
  'features.apps': false,
  'features.multi_agent': false,
  'features.memories': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'features.image_generation': false,
  web_search: 'disabled',
  allow_login_shell: false,
  'shell_environment_policy.inherit': 'none',
};
/**
 * Thread overrides for read-only chats and side questions. MCP tools run outside the sandbox, and a
 * process-level grant otherwise stays connected in read-only threads (observed on 0.152.0), so every
 * configured server is switched off per thread.
 */
export function restrictedThreadConfig(mcpServers: string[] = []) {
  return {
    ...restrictedConfig,
    ...Object.fromEntries(mcpServers.map(name => [`mcp_servers.${name}.enabled`, false])),
  };
}
export function runtimeSettings(config: Record<string, any>): RuntimeSettings {
  return {
    model: typeof config.model === 'string' ? config.model : undefined,
    effort: typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : undefined,
    profile:
      typeof config.default_permissions === 'string'
        ? config.default_permissions
        : config.sandbox_mode === 'workspace-write'
          ? ':workspace'
          : config.sandbox_mode === 'danger-full-access'
            ? ':danger-full-access'
            : ':read-only',
    approval: config.approval_policy ?? 'on-request',
    reviewer: config.approvals_reviewer ?? 'user',
    memories: config.features?.memories === true,
    provider: typeof config.model_provider === 'string' ? config.model_provider : 'openai',
    // Unsafe names are refused at connection time; never splice one into a config key here.
    mcpServers: Object.keys(
      config.mcp_servers && typeof config.mcp_servers === 'object' ? config.mcp_servers : {},
    ).filter(name => /^[A-Za-z0-9_-]{1,100}$/.test(name)),
  };
}
