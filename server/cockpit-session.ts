import type { FleetGame } from './game.ts';
import { CockpitStore, cockpitRouter } from './cockpit.ts';
import { createDroneTools } from './runtime-tools.ts';
import type { CockpitToolEvidence } from '../shared/cockpit.ts';

/** Shared production/trial wiring for read-only cockpit evidence. */
export function createCockpit(game: FleetGame) {
  const store = new CockpitStore();
  return {
    router: cockpitRouter({ store, state: () => game.state,
      onboard: id => game.existingOnboardWorkspace(id),
      tools: id => createDroneTools(undefined, game.toolCapabilities(id)).map(tool => tool.name) }),
    reset: () => store.reset(null),
    begin(audit: (type: string, value: unknown) => void) {
      const sessionId = game.sessionIdentity;
      store.reset(sessionId);
      return {
        onToolEvidence: (event: CockpitToolEvidence) => store.recordTool(sessionId, event),
        onEvent: (type: string, event: unknown) => {
          if (type === 'agent') {
            store.recordRuntime(sessionId, event);
            const value = event as { streaming?: boolean; type?: string } | null;
            // The cockpit owns streaming text; only completed/partial items enter audits.
            if (value?.streaming || ['actor-message-delta', 'reasoning-summary-delta', 'reasoning-text-delta'].includes(value?.type ?? '')) return;
          }
          audit(type, event);
        },
      };
    },
  };
}
