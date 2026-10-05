import type {
  Action, ActionStatus, Approval, AuditEntry, Channel, Contact, EventSource, EventStatus,
  HarnessEvent, Lease, MaintenanceRequest, Message, Owner, SystemState, Tenant, Vendor,
} from "./types";

export interface NewEvent {
  type: string;
  source: EventSource;
  externalId: string;
  contactId?: string;
  payload: Record<string, unknown>;
  receivedAt: Date;
}

export type NewMessage = Omit<Message, "id">;
export type NewAction = Omit<Action, "id">;

/**
 * Everything the harness needs from storage. The in-memory implementation backs
 * unit tests and evals; the Postgres implementation (Phase 1b) must pass the same
 * behaviour. Methods that guard against races are compare-and-set and say so.
 */
export interface Store {
  // People
  getOwner(): Promise<Owner>;
  getContact(id: string): Promise<Contact | null>;
  findContactByPhone(phone: string): Promise<Contact | null>;
  findContactByEmail(email: string): Promise<Contact | null>;
  listContacts(): Promise<Contact[]>;

  // Events
  /** Idempotent on (source, externalId). `inserted` is false for a provider retry. */
  insertEvent(e: NewEvent): Promise<{ event: HarnessEvent; inserted: boolean }>;
  getEvent(id: string): Promise<HarnessEvent | null>;
  setEventStatus(id: string, status: EventStatus): Promise<void>;
  /** Compare-and-set: true only for the first caller for this event. */
  markEmergencyHit(eventId: string): Promise<boolean>;

  // Messages
  getOrCreateThread(channel: Channel, contactId: string): Promise<string>;
  insertMessage(m: NewMessage): Promise<Message>;
  listThreadMessages(threadId: string, since?: Date): Promise<Message[]>;
  countOutbound(contactId: string, channel: Channel, since: Date): Promise<number>;
  /** When the given template was last sent to this contact, if ever. */
  lastOutboundTemplateAt(contactId: string, templateId: string): Promise<Date | null>;

  // Actions (outbox)
  /** Idempotent on idempotencyKey: a repeat returns the existing row with inserted=false. */
  insertAction(a: NewAction): Promise<{ action: Action; inserted: boolean }>;
  getAction(id: string): Promise<Action | null>;
  /** The action in an open status (held or pending_approval) carrying this code. */
  findOpenActionByCode(code: string): Promise<Action | null>;
  listActions(filter?: { status?: ActionStatus[] }): Promise<Action[]>;
  /**
   * Compare-and-set: moves the action to `to` only if its current status is in
   * `from`. Returns the updated action, or null if someone else got there first.
   */
  transitionAction(
    id: string,
    from: ActionStatus[],
    to: ActionStatus,
    patch?: Partial<Pick<Action, "executedResult" | "sendAt">>,
  ): Promise<Action | null>;
  insertApproval(a: Approval): Promise<void>;
  listApprovals(actionId: string): Promise<Approval[]>;

  // Control plane
  getSystemState(): Promise<SystemState>;
  setPaused(paused: boolean, by: string, at: Date): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;

  // Domain reads and writes used by tools
  getTenantByContact(contactId: string): Promise<Tenant | null>;
  getActiveLease(propertyId: string): Promise<Lease | null>;
  listRequests(propertyId: string, opts?: { openOnly?: boolean }): Promise<MaintenanceRequest[]>;
  getRequest(id: string): Promise<MaintenanceRequest | null>;
  insertRequest(r: Omit<MaintenanceRequest, "id">): Promise<MaintenanceRequest>;
  updateRequest(
    id: string,
    patch: Partial<Omit<MaintenanceRequest, "id" | "propertyId" | "createdAt">>,
    actor: "agent" | "owner" | "system",
    at: Date,
  ): Promise<MaintenanceRequest>;
  listVendors(): Promise<Vendor[]>;
  getVendor(id: string): Promise<Vendor | null>;
  vendorHasPriorJob(vendorId: string): Promise<boolean>;
  insertExpense(e: {
    propertyId: string; requestId?: string; vendorId?: string;
    category: string; amountCents: number; incurredOn: string;
  }): Promise<{ id: string }>;
  insertCalendarEvent(e: {
    providerEventId: string; kind: "vendor_visit"; requestId?: string; startsAt: Date; endsAt: Date;
  }): Promise<{ id: string }>;
}
