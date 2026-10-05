import type { Store } from "../store";

/** What the owner's text means, judged from the text alone. No database lookups. */
export type OwnerCommand =
  | { kind: "approve"; code: string }
  | { kind: "reject"; code: string }
  | { kind: "undo"; code: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "status" }
  /**
   * Free text that mentions one or more 4-digit numbers that could be approval
   * codes. The flow decides whether any of them is actually open.
   */
  | { kind: "revise"; candidateCodes: string[]; instruction: string }
  | { kind: "unrecognized" };

export type ExecuteOutcome =
  | { status: "executed"; result: unknown }
  | { status: "blocked_paused" }
  | { status: "failed"; error: string }
  /** The action was not in a state that can be executed (someone else got there first). */
  | { status: "skipped"; reason: string };

export interface ApprovalDeps {
  store: Store;
  /** Runs the stored, already-validated args of an approved action. Never calls the model. */
  execute: (actionId: string) => Promise<ExecuteOutcome>;
  /** Sends a short reply to the owner. Owner-directed messages are never paused. */
  notifyOwner: (text: string) => Promise<void>;
  /** Queues a revision for the agent, linked to the action being revised. */
  enqueueRevision: (job: { actionId: string; instruction: string; sourceEventId: string }) => Promise<void>;
  now: () => Date;
}

export interface OwnerSmsInput {
  /** Already inserted and deduplicated. */
  eventId: string;
  /** Sender number exactly as Twilio delivered it. */
  from: string;
  body: string;
  /** Result of Twilio signature verification for this request. */
  signatureValid: boolean;
}

export type OwnerSmsResult =
  /** Not from the verified owner, or not a command. The caller routes it to the agent as untrusted text. */
  | { handled: false; reason: "not_owner" | "not_a_command" }
  | {
      handled: true;
      command: OwnerCommand["kind"];
      outcome:
        | "approved_executed"
        | "approved_blocked_paused"
        | "approved_failed"
        | "rejected"
        | "undone"
        | "revision_queued"
        | "paused"
        | "resumed"
        | "status_sent"
        | "unknown_code"
        | "expired"
        | "already_decided"
        | "wrong_state"; // e.g. U- on an action awaiting approval, or after it was sent
      actionId?: string;
    };
