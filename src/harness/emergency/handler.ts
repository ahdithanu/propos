/**
 * LEARNING MODE — yours to implement. See docs/learning/emergency-path.md and
 * tests/learning/emergency-handler.test.ts.
 */
import type { EmergencyDeps, EmergencyInput, EmergencyOutcome } from "./types";

/**
 * Runs inside the webhook, after the event is inserted and before it is queued.
 * On a hit: safety template to the sender, alert to the owner, no model, no queue.
 * Must never throw: the webhook still has to enqueue the event and return 200.
 */
export async function handleEmergency(deps: EmergencyDeps, input: EmergencyInput): Promise<EmergencyOutcome> {
  void deps; void input;
  throw new Error("Not implemented: handleEmergency");
}
