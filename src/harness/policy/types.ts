import type { Policy } from "@/config/policy";
import type { ContactKind, Tier } from "../types";

/**
 * read:   returns data, changes nothing.
 * draft:  changes internal records only (a request row, an expense row).
 * action: has an effect outside the system (a message, a calendar event).
 */
export type ToolKind = "read" | "draft" | "action";

export type ToolCategory = "payment" | "signing" | "delete" | "policy_write";

/** Tools in these categories are always Tier 3. Code, not config: nothing can loosen it. */
export const HARD_DENY_CATEGORIES: readonly ToolCategory[] = ["payment", "signing", "delete", "policy_write"];

export interface PolicyToolInfo {
  name: string;
  kind: ToolKind;
  /** Floor declared in the tool's code. Config can raise it, never go below it. */
  baseTier: Tier;
  categories: ToolCategory[];
}

/**
 * Deterministic facts about one proposed tool call. The registry computes these
 * from the database and the validated args; the model never supplies them.
 */
export interface ActionFacts {
  /** Present when the call sends something to a person. */
  recipient?: {
    /** False when the address or contact id is not in `contacts`. */
    known: boolean;
    kind?: ContactKind;
    isOwner: boolean;
    /** True when the recipient is the contact whose message triggered this run. */
    isEventContact: boolean;
    /** Vendors only: has this vendor completed a job for this owner before? */
    vendorHasPriorJob?: boolean;
  };
  /** Money this call would commit, in cents. Absent when no money is involved. */
  amountCents?: number;
  /** undefined: no message. null: free text. string: an approved template id. */
  templateId?: string | null;
  /** Content touches rent, lease terms or anything legal. */
  sensitive?: boolean;
  /** The outbound text contains a phone or email belonging to someone other than the recipient. */
  containsOtherPartyPii?: boolean;
}

export interface PolicyInput {
  tool: PolicyToolInfo;
  facts: ActionFacts;
  /** The agent asked for owner review. It can only raise the tier. */
  agentRequestedReview: boolean;
  /** Effective policy: file defaults with dashboard overrides already applied. */
  policy: Policy;
}

export type TierRule =
  | "tool_floor"
  | "config_floor"
  | "hard_deny_category"
  | "unknown_recipient"
  | "other_party_pii"
  | "vendor_no_prior_job"
  | "amount_over_auto_approve"
  | "sensitive_content"
  | "free_text"
  | "agent_requested_review"
  | "invalid_input";

export interface TierReason {
  rule: TierRule;
  /** The tier this rule demands on its own. */
  tier: Tier;
}

export interface PolicyDecision {
  /** Always the maximum of `reasons[].tier`, or 0 when there are none. */
  tier: Tier;
  /** Every rule that applied, not only the winning one. Stored on the action and the step. */
  reasons: TierReason[];
}

export type PolicyEvaluator = (input: PolicyInput) => PolicyDecision;

export interface PolicyOverride {
  /** Dotted path into the policy, e.g. "tiers.tools.send_template_message". */
  path: string;
  value: unknown;
}

/** The only settings the dashboard may override. Everything else stays file-only. */
export const OVERRIDABLE_PATHS: readonly string[] = [
  "tiers.default_tool_tier",
  "spend.auto_approve_max_cents",
  "undo_window_minutes",
  "approvals.code_ttl_hours",
  "rate_limits.sms_per_recipient_per_day",
  "rate_limits.email_per_recipient_per_day",
];
/** Plus `tiers.tools.<tool name>` for any registered tool. */
export const OVERRIDABLE_TOOL_TIER_PREFIX = "tiers.tools.";

export interface OverrideResult {
  /** A new object. The input policy is never mutated. */
  policy: Policy;
  applied: string[];
  rejected: { path: string; reason: string }[];
}
