import type { AttentionEvidence, AttentionOptions, Bridge } from 'nervelet';
import type { GameEvent } from '../shared/types.ts';

/** Experimental, per-match opt-in. Values are qualification budgets, not physical guarantees. */
export const ATTENTION_LIMITS: AttentionOptions = Object.freeze({ maxTransitions: 6, maxInterrupts: 4,
  cooldownMs: 5000, terminationMs: 15000, maxEvidenceAgeMs: 20000, maxEvidenceBytes: 1024 });

/** Domain classification and episode policy only; Nervelet owns the transition. */
export class OnboardAttentionPolicy {
  private episode?: string;
  private receivedMs = -Infinity;
  select(event: GameEvent, receivedMs: number, bridge: Bridge): AttentionEvidence | undefined {
    const damage = event.type === 'armor_lost';
    const acoustic = event.type === 'acoustic_impulse' && event.possibleShot === true;
    if ((!damage && !acoustic) || !Number.isFinite(event.simTime)) return;
    const separated = receivedMs - this.receivedMs >= 2000;
    const episode = damage || !this.episode || separated ? `${event.type}:${event.cursor}` : this.episode;
    this.receivedMs = receivedMs;
    const active = bridge.attention();
    if (active && !['pending', 'ready'].includes(active.status)) {
      // Acknowledgement + cooldown is necessary but insufficient: new factual
      // damage or a new acoustic episode after quiet is also required.
      if (active.status !== 'acknowledged' || episode === this.episode) return;
      try { bridge.rearmAttention(active.id); } catch { return; }
    }
    this.episode = episode;
    return { episode, receivedMs, acquired: { clock: 'simulation', ms: Number(event.simTime) * 1000 },
      eventIds: [`${bridge.epoch}:e${event.cursor}`],
      data: damage ? { type: 'armor_lost', cause: event.cause === 'collision' ? 'collision' : 'hit', simTime: Number(event.simTime) }
        : { type: 'acoustic_impulse', possibleShot: true, uncertain: true, simTime: Number(event.simTime) } };
  }
}
