/** Shared domain types for the harness. Storage-agnostic: no SQL or Supabase here. */

export type Tier = 0 | 1 | 2 | 3;
export type Channel = "sms" | "email";
export type ContactKind = "tenant" | "vendor" | "owner" | "agency" | "utility" | "hoa";

export interface Contact {
  id: string;
  kind: ContactKind;
  displayName: string;
  firstName?: string;
  phone?: string;
  email?: string;
  preferredChannel: Channel;
  preferredLanguage: string;
  isAllowlisted: boolean;
}

export interface Owner {
  contactId: string;
  phone: string;
  email: string;
}

export type EventSource = "twilio" | "gmail" | "tick" | "dashboard";
export type EventStatus = "received" | "queued" | "processing" | "done" | "failed" | "suppressed";

export interface HarnessEvent {
  id: string;
  type: string;
  source: EventSource;
  externalId: string;
  contactId?: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  emergencyHit: boolean;
  receivedAt: Date;
}

export interface Message {
  id: string;
  threadId: string;
  eventId?: string;
  direction: "inbound" | "outbound";
  channel: Channel;
  contactId: string;
  body: string;
  redactedBody: string;
  providerId?: string;
  templateId?: string;
  isAutoReply: boolean;
  createdAt: Date;
}

export type ActionStatus =
  | "proposed"
  | "held" // Tier 1: waiting out the undo window
  | "pending_approval" // Tier 2: waiting for the owner
  | "approved"
  | "rejected"
  | "revising"
  | "executing"
  | "executed"
  | "failed"
  | "undone"
  | "expired"
  | "blocked_paused"
  | "refused"; // Tier 3

/** Statuses in which an approval code still refers to a live action. */
export const OPEN_CODE_STATUSES: readonly ActionStatus[] = ["held", "pending_approval"];

export interface Action {
  id: string;
  runId?: string;
  /** The contact whose event caused this action; tools are scoped to it. */
  scopeContactId?: string;
  toolName: string;
  /** Validated tool input, stored so approval can execute it without asking the model again. */
  args: unknown;
  /** Owner-facing one-line description, written when the action was proposed. */
  summary: string;
  effectiveTier: Tier;
  tierReasons: string[];
  status: ActionStatus;
  approvalCode?: string;
  codeExpiresAt?: Date;
  sendAt?: Date;
  idempotencyKey: string;
  executedResult?: unknown;
  parentActionId?: string;
  createdAt: Date;
}

export interface Approval {
  actionId: string;
  channel: "sms" | "dashboard";
  decision: "approve" | "reject" | "edit" | "undo";
  ownerText?: string;
  decidedAt: Date;
}

export interface AuditEntry {
  at: Date;
  actor: "agent" | "owner" | "system";
  action: string;
  entity: string;
  entityId?: string;
  /** Must already be redacted. */
  details: Record<string, unknown>;
  runId?: string;
}

export interface SystemState {
  paused: boolean;
  pausedAt?: Date;
  pausedBy?: string;
}

export type Urgency = "emergency" | "urgent" | "routine" | "cosmetic";
export type RequestStatus =
  | "new" | "info_needed" | "vendor_requested" | "quoted" | "scheduled"
  | "in_progress" | "done" | "closed" | "cancelled";

export interface MaintenanceRequest {
  id: string;
  propertyId: string;
  tenantId?: string;
  title: string;
  category: string;
  urgency: Urgency;
  urgencyReason?: string;
  status: RequestStatus;
  missingInfo: string[];
  vendorId?: string;
  quoteCents?: number;
  scheduledStart?: Date;
  createdAt: Date;
  closedAt?: Date;
}

export interface Vendor {
  id: string;
  contactId: string;
  trades: string[];
  preapproved: boolean;
  autoSpendLimitCents: number;
  rating?: number;
  notes?: string;
}

export interface Tenant {
  id: string;
  contactId: string;
  propertyId: string;
  status: "active" | "former" | "applicant";
}

export interface Lease {
  id: string;
  propertyId: string;
  startDate: string;
  endDate: string;
  monthlyRentCents: number;
  dueDay: number;
  graceDays: number;
  status: "draft" | "active" | "ended";
}
