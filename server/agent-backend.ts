import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Role, ToolResult } from '../shared/types.ts';
import type { FleetRoster } from '../shared/fleet.ts';

/** The simulated onboard brain is replaceable; its observation boundary is not. */
export interface AgentBackendConfiguration {
  provider: 'codex';
  model: 'gpt-5.6-luna';
  effort: 'xhigh';
}
export const DEFAULT_AGENT_BACKEND: Readonly<AgentBackendConfiguration> = Object.freeze({
  provider: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh',
});

export function validateAgentBackend(configuration: AgentBackendConfiguration = DEFAULT_AGENT_BACKEND): Readonly<AgentBackendConfiguration> {
  if (configuration.provider !== 'codex') throw new Error(`Unsupported agent backend: ${String(configuration.provider)}. No provider fallback is permitted.`);
  if (configuration.model !== DEFAULT_AGENT_BACKEND.model || configuration.effort !== DEFAULT_AGENT_BACKEND.effort) {
    throw new Error('Gameplay requires explicitly configured gpt-5.6-luna / xhigh. No model or reasoning fallback is permitted.');
  }
  return Object.freeze({ provider: configuration.provider, model: configuration.model, effort: configuration.effort });
}

/** No filesystem, host archive, world state or unrestricted network handle crosses this boundary. */
export interface AgentBackendOptions {
  projectDir: string;
  roster?: FleetRoster;
  team?: 'blue' | 'red';
  backend?: AgentBackendConfiguration;
  toolsForRole?: (role: Role) => Tool[];
  toolHandler: (role: Role, name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onStatus: (status: Record<string, unknown>) => void;
  onEvent: (event: Record<string, unknown>) => void;
}

/** Providers must preserve fresh tool/next-turn boundaries, actor identity, and revocable capabilities.
 * Private model reasoning is not an input boundary. Inference hardware/storage are abstracted;
 * authored files, local routine budgets and actual tool latency remain game-owned constraints.
 */
export interface AgentBackend {
  readonly configuration: Readonly<AgentBackendConfiguration>;
  start(): Promise<void>;
  stop(): Promise<void>;
  retireDrone(role: Role): Promise<void>;
  refreshTools(): Promise<void>;
  toolsForRole(role: Role): Tool[];
}
