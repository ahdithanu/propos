import type { MessageTemplate, Templates } from "@/config/policy";
import type { SmsPort } from "../ports";
import type { Store } from "../store";
import type { Contact } from "../types";

export type EmergencyCategory =
  | "gas" | "fire" | "flood" | "electrical" | "carbon_monoxide"
  | "no_heat" | "no_water" | "injury" | "sewage" | "security";

/** One rule in policy/emergency-rules.yaml. */
export interface EmergencyRule {
  id: string;
  category: EmergencyCategory;
  /** "any" for patterns that work in both languages. */
  language: "en" | "es" | "any";
  /** JavaScript regular expression source, matched against normalized text. */
  pattern: string;
}

export interface EmergencyRuleSet {
  version: number;
  rules: EmergencyRule[];
}

export interface EmergencyMatch {
  ruleId: string;
  category: EmergencyCategory;
  /** The substring of the normalized text that matched. */
  matched: string;
}

/** The safety template every language must provide. */
export const EMERGENCY_TEMPLATE_ID = "emergency_safety";

export interface EmergencyInput {
  /** Already inserted and deduplicated. */
  eventId: string;
  /** Null when the sender's number is not in contacts. */
  contact: Contact | null;
  /** The sender's address as received, for the owner alert when contact is null. */
  fromAddress: string;
  body: string;
  /** Result of the auto-reply detector for this message. */
  isAutoReply: boolean;
}

export interface EmergencyDeps {
  /** Send through this port directly. In staging it is already the redirecting wrapper. */
  sms: SmsPort;
  store: Store;
  rules: EmergencyRuleSet;
  templates: Templates;
  config: { cooldownMinutes: number; sendAttempts: number };
  now: () => Date;
  /** Wait between in-process retries. Injected so tests do not sleep. */
  sleep: (ms: number) => Promise<void>;
  /** Last resort when in-process retries are exhausted: a high-priority queued send. */
  enqueueFallback: (job: { to: string; body: string; idempotencyKey: string }) => Promise<void>;
}

export type TenantReplyOutcome =
  | "sent"
  | "queued_fallback" // retries exhausted, handed to the queue
  | "held_paused" // kill switch is on (decisions.md D7)
  | "cooldown" // safety reply already sent to this contact recently
  | "skipped_auto_reply" // never answer a machine
  | "skipped_unknown_sender" // never text a number that is not in contacts
  | "not_applicable"; // no emergency, or sender is the owner

export type OwnerAlertOutcome = "sent" | "queued_fallback" | "not_applicable";

export interface EmergencyOutcome {
  hit: boolean;
  match?: EmergencyMatch;
  tenantReply: TenantReplyOutcome;
  ownerAlert: OwnerAlertOutcome;
}

export type EmergencyHandler = (deps: EmergencyDeps, input: EmergencyInput) => Promise<EmergencyOutcome>;

export type { MessageTemplate };
