/**
 * LEARNING MODE — yours to implement. See docs/learning/approval-flow.md and
 * tests/learning/approval-flow.test.ts.
 */
import type { ApprovalDeps, OwnerSmsInput, OwnerSmsResult } from "./types";

/**
 * Handles one inbound SMS that might be an owner command. Verifies the sender,
 * parses, and applies the decision to the stored action.
 */
export async function handleOwnerSms(deps: ApprovalDeps, input: OwnerSmsInput): Promise<OwnerSmsResult> {
  void deps; void input;
  throw new Error("Not implemented: handleOwnerSms");
}
