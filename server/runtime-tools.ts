import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_FLEET, DRONE_IDS, droneAgentType, type FleetRoster } from '../shared/fleet.ts';
import type { Role } from '../shared/types.ts';
import { RTS_CONFIG } from '../shared/rts.ts';
import { ACTOR_MODEL as MODEL, ACTOR_EFFORT as EFFORT, DRONE_HOST_LIBRARIES } from '../shared/actor-environment.ts';

export { MODEL, EFFORT };
export const RTS_MISSION = 'Eliminate the enemy team. Your team wins if at least one of you survives and every enemy drone is destroyed. Resources exist somewhere in this world; find and gather them. Coordinate with your teammates and learn from your own observations. Touching terrain, buildings or other drones can destroy you.';
export type FleetRole = Role;
export const DRONES = DRONE_IDS;
const object = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const mission = { type: 'integer', minimum: 1, description: 'The mission version you last received. Never guess a newer version.' };
const number = { type: 'number' };

export const relayTool: Tool = { name: 'forward_next_instruction', description: 'Wait for a player instruction and copy its original text to every drone. Returns acknowledgement only. Repeat until stopped.', inputSchema: object({}) };
export interface ToolCapabilities { shop: boolean; gun: boolean; alive: boolean }
export function createDroneTools(roster: FleetRoster = DEFAULT_FLEET, capabilities: ToolCapabilities = { shop: false, gun: false, alive: true }): Tool[] {
  if (!capabilities.alive) return [];
  const tools: Tool[] = [
  { name: 'observe', description: 'Get a fresh camera, own position, heading and acquisition timestamp, together with all unread events. Every drone tool returns this bundle automatically.', inputSchema: object({}) },
  { name: 'act', description: 'Start or replace a command without waiting for physical completion. fly_to takes an absolute XYZ target in your position sensor frame; look takes heading in degrees and an optional camera pitch command; hover stops motion. Returns fresh sensors and unread events. Learn movement and camera effects by observation.', inputSchema: object({ mission, kind: { enum: ['fly_to', 'look', 'hover'] }, x: number, y: number, z: number, heading: number, pitch: number }, ['mission', 'kind']) },
  { name: 'send', description: 'Send actual radio speech to one teammate or all. Sender identity is supplied by the server. Communicate intentions, discoveries, claims and completion.', inputSchema: object({ mission, to: { enum: ['all', ...roster.map(member => member.id)] }, kind: { enum: ['chat', 'found', 'claim', 'done'] }, text: { type: 'string', maxLength: 1200 }, data: { type: 'object', additionalProperties: true } }, ['mission', 'to', 'kind', 'text']) },
  { name: 'wait', description: 'Sleep asynchronously until unread mail, a controller event, or timeout, then receive fresh sensors and all unread events. Normally omit after: delivery is tracked automatically. Use this while idle or moving instead of polling observe.', inputSchema: object({ after: { type: 'integer', minimum: 0 }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 30000, default: 30000 } }) },
  { name: 'mine', description: 'Start gathering a nearby resource you have observed. Gathering continues asynchronously while you remain in reach. Returns fresh sensors and unread events. Learn resource interactions from your observations and receipts.', inputSchema: object({ mission }, ['mission']) },
  ];
  if (capabilities.shop) tools.push({ name: 'buy', description: `Spend shared team credits to attach an item to yourself. Gun costs ${RTS_CONFIG.prices.gun} credits and fires along camera aim. Armor costs ${RTS_CONFIG.prices.armor} credits and absorbs one bullet, terrain collision or ram, then is consumed. Miner costs ${RTS_CONFIG.prices.miner} credits and speeds resource extraction. Coordinate who equips which items with teammates; each buys their own attachment. Read the receipt to learn the result.`, inputSchema: object({ mission, item: { enum: ['gun', 'armor', 'miner'] } }, ['mission', 'item']) });
  if (capabilities.gun) tools.push({ name: 'fire', description: 'Fire your attached gun along your current camera aim. Use look to aim, then observe the shot and learn its flight. Returns fresh sensors and unread events.', inputSchema: object({ mission }, ['mission']) });
  return tools;
}
export const droneTools = createDroneTools();

export function droneInstructions(role: FleetRole, roster: FleetRoster = DEFAULT_FLEET, team?: 'blue' | 'red') {
  return `${role}, autonomous drone.${team ? ` ${team} team; blue/cyan opposes red.` : ''} Team roster: ${roster.map(member => member.id).join(', ')}.
Objective: gather resources, coordinate, eliminate every enemy while one of us survives. Collisions can be fatal.
Inputs: own camera, local XYZ (not latitude/longitude), heading degrees, acquisition timestamp, received mail, unlocked equipment/balance. No roll/pitch sensor. World/controls start uncalibrated: experiment, compare observations, distinguish guesses, share measurements/uncertainty. Keep clear of reported teammate positions.
Compute: ${MODEL}/${EFFORT}; current fleet MCP tools only, one call at a time. Host libraries: ${DRONE_HOST_LIBRARIES.map(library => `${library.name} for ${library.purpose}`).join(', ')}. No direct library access, code execution, shell, filesystem, web, spawning or native agent messages.
Loop: wait for initial mission; read every result's fresh sensors/events before deciding. Movement/mining continue during reasoning; mail waits for tool results. Use wait while moving/idle or camera unavailable. Use send to coordinate roles/intentions. Keep reasoning/radio concise. Use only the received mission version; newly delivered missions cancel old movement/mining. Respect rejections/message expiry. Continue until stopped/destroyed.
On tool_catalog_changed, read the complete result, then finish this turn immediately with a brief acknowledgement and no further tools; the same actor resumes with refreshed tools and preserved mission/history.`;
}

export const BOOTSTRAP_MESSAGE = 'Begin your drone event loop. Wait for the player mission, then coordinate with your peers using only your fleet tools.';
export function createParentInstructions(roster: FleetRoster = DEFAULT_FLEET) { return `You are the mechanical relay for a drone simulation. You MUST use ${MODEL} with ${EFFORT} reasoning, and all children MUST use that same model and effort. Bootstrap exactly ${roster.length} native subagents, agent types ${roster.map(member => droneAgentType(member.id)).join(', ')}, one each. Use clean context (fork_context=false, or fork_turns=none if supported), and give each exactly this startup message: ${BOOTSTRAP_MESSAGE}\nAfter all ${roster.length} exist, repeatedly call fleet.forward_next_instruction. That tool waits and publishes original player messages through the network. Its acknowledgement means queued; delivery to each drone may be delayed. You never receive or interpret mission contents. Do not plan missions, inspect drone histories, send agent messages, change prompts, spawn extra agents, use shell or filesystem, or give final answers while tools say the game is running. Do not wait for child completion: they run continuously. When the relay says stopped, finish.`;
}
export const parentInstructions = createParentInstructions();
