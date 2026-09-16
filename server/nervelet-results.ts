import { resultBytes } from 'nervelet';
import type { Command, Json, Profile, ResultBudget } from 'nervelet';

const KiB = 1024;

/** This payload pool is part of the existing 384 KiB cache reservation. The
 * other 192 KiB covers profile/instructions/goals and bounded protocol records.
 * Encoded output is a separate transient budget, never retained JSON strings. */
export const NERVELET_RESULT_LIMITS = Object.freeze({
  maxResultBytes: 192 * KiB,
  maxRetainedResultBytes: 192 * KiB,
  maxResultDeliveryBytes: 480 * KiB,
  receiptHistory: 16,
  bundleHistory: 8,
});

/** Storage abstraction, not process RSS. Charge the complete immutable profile,
 * one rendered instruction string, the maximum received goal, every receipt and
 * executor record, every possible delivery/result reference and fixed control
 * metadata. Camera/serialization buffers are transient and bounded separately. */
export function cacheAccounting(profile: Profile, instructions: string) {
  const profileBytes = resultBytes(profile as unknown as Json);
  const instructionBytes = resultBytes(instructions);
  const goalBytes = 2 * 24 * KiB + 512;
  const receiptBytes = NERVELET_RESULT_LIMITS.receiptHistory * 1536;
  const deliveryBytes = NERVELET_RESULT_LIMITS.bundleHistory * (256 + NERVELET_RESULT_LIMITS.receiptHistory * 96);
  const controlBytes = 5 * KiB;
  const metadataBytes = profileBytes + instructionBytes + goalBytes + receiptBytes + deliveryBytes + controlBytes;
  if (metadataBytes > 192 * KiB) throw new Error('Nervelet metadata exceeds the existing cache reservation');
  return { profileBytes, instructionBytes, goalBytes, receiptBytes, deliveryBytes, controlBytes,
    metadataBytes, resultBytes: NERVELET_RESULT_LIMITS.maxRetainedResultBytes,
    reservedBytes: 384 * KiB };
}

/** Reserve worst-case output before dispatch, including an asynchronous routine
 * changing a file after admission. Exchanges cannot contain workspace reads.
 * These are bounds on the original operation result, excluding fresh sensors. */
export function resultBudget(command: Command): ResultBudget {
  if (command.kind === 'workspace' && command.args.op === 'read')
    return { retainedBytes: 144 * KiB, serializedBytes: 480 * KiB };
  if (command.kind === 'workspace' && command.args.op === 'list')
    return { retainedBytes: 180 * KiB, serializedBytes: 128 * KiB };
  if (command.kind === 'transfer')
    return { retainedBytes: 96 * KiB, serializedBytes: 96 * KiB };
  if (command.kind === 'exchange')
    return { retainedBytes: 64 * KiB, serializedBytes: 64 * KiB };
  return { retainedBytes: 16 * KiB, serializedBytes: 32 * KiB };
}
