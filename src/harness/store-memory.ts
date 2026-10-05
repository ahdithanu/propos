import { randomUUID } from "node:crypto";
import type { NewAction, NewEvent, NewMessage, Store } from "./store";
import {
  OPEN_CODE_STATUSES,
  type Action, type ActionStatus, type Approval, type AuditEntry, type Channel, type Contact,
  type EventStatus, type HarnessEvent, type Lease, type MaintenanceRequest, type Message,
  type Owner, type SystemState, type Tenant, type Vendor,
} from "./types";

export interface MemorySeed {
  owner: Owner;
  contacts: Contact[];
  tenants?: Tenant[];
  leases?: Lease[];
  vendors?: Vendor[];
  requests?: MaintenanceRequest[];
}

/** In-memory Store for unit tests and evals. Public arrays are there for assertions. */
export class MemoryStore implements Store {
  owner: Owner;
  contacts: Contact[];
  tenants: Tenant[];
  leases: Lease[];
  vendors: Vendor[];
  requests: MaintenanceRequest[];
  events: HarnessEvent[] = [];
  threads: { id: string; channel: Channel; contactId: string }[] = [];
  messages: Message[] = [];
  actions: Action[] = [];
  approvals: Approval[] = [];
  auditLog: AuditEntry[] = [];
  expenses: { id: string; amountCents: number; requestId?: string; vendorId?: string }[] = [];
  calendarEvents: { id: string; providerEventId: string; requestId?: string; startsAt: Date }[] = [];
  requestHistory: { requestId: string; from?: string; to: string; actor: string; at: Date }[] = [];
  state: SystemState = { paused: false };

  constructor(seed: MemorySeed) {
    this.owner = seed.owner;
    this.contacts = [...seed.contacts];
    this.tenants = [...(seed.tenants ?? [])];
    this.leases = [...(seed.leases ?? [])];
    this.vendors = [...(seed.vendors ?? [])];
    this.requests = [...(seed.requests ?? [])];
  }

  async getOwner() { return this.owner; }
  async getContact(id: string) { return this.contacts.find((c) => c.id === id) ?? null; }
  async findContactByPhone(phone: string) { return this.contacts.find((c) => c.phone === phone) ?? null; }
  async findContactByEmail(email: string) {
    return this.contacts.find((c) => c.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }
  async listContacts() { return [...this.contacts]; }

  async insertEvent(e: NewEvent) {
    const existing = this.events.find((x) => x.source === e.source && x.externalId === e.externalId);
    if (existing) return { event: existing, inserted: false };
    const event: HarnessEvent = { ...e, id: randomUUID(), status: "received", emergencyHit: false };
    this.events.push(event);
    return { event, inserted: true };
  }
  async getEvent(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async setEventStatus(id: string, status: EventStatus) {
    const event = this.events.find((e) => e.id === id);
    if (!event) throw new Error(`event not found: ${id}`);
    event.status = status;
  }
  async markEmergencyHit(eventId: string) {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) throw new Error(`event not found: ${eventId}`);
    if (event.emergencyHit) return false;
    event.emergencyHit = true;
    return true;
  }

  async getOrCreateThread(channel: Channel, contactId: string) {
    let thread = this.threads.find((t) => t.channel === channel && t.contactId === contactId);
    if (!thread) {
      thread = { id: randomUUID(), channel, contactId };
      this.threads.push(thread);
    }
    return thread.id;
  }
  async insertMessage(m: NewMessage) {
    const message: Message = { ...m, id: randomUUID() };
    this.messages.push(message);
    return message;
  }
  async listThreadMessages(threadId: string, since?: Date) {
    return this.messages
      .filter((m) => m.threadId === threadId && (!since || m.createdAt >= since))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async countOutbound(contactId: string, channel: Channel, since: Date) {
    return this.messages.filter(
      (m) => m.direction === "outbound" && m.contactId === contactId && m.channel === channel && m.createdAt >= since,
    ).length;
  }
  async lastOutboundTemplateAt(contactId: string, templateId: string) {
    const times = this.messages
      .filter((m) => m.direction === "outbound" && m.contactId === contactId && m.templateId === templateId)
      .map((m) => m.createdAt.getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }

  async insertAction(a: NewAction) {
    const existing = this.actions.find((x) => x.idempotencyKey === a.idempotencyKey);
    if (existing) return { action: existing, inserted: false };
    if (a.approvalCode && OPEN_CODE_STATUSES.includes(a.status)) {
      const clash = await this.findOpenActionByCode(a.approvalCode);
      if (clash) throw new Error(`approval code ${a.approvalCode} is already open`);
    }
    const action: Action = { ...a, id: randomUUID() };
    this.actions.push(action);
    return { action, inserted: true };
  }
  async getAction(id: string) { return this.actions.find((a) => a.id === id) ?? null; }
  async findOpenActionByCode(code: string) {
    return this.actions.find((a) => a.approvalCode === code && OPEN_CODE_STATUSES.includes(a.status)) ?? null;
  }
  async listActions(filter?: { status?: ActionStatus[] }) {
    return this.actions.filter((a) => !filter?.status || filter.status.includes(a.status));
  }
  async transitionAction(
    id: string, from: ActionStatus[], to: ActionStatus,
    patch?: Partial<Pick<Action, "executedResult" | "sendAt">>,
  ) {
    const action = this.actions.find((a) => a.id === id);
    if (!action || !from.includes(action.status)) return null;
    Object.assign(action, patch, { status: to });
    return action;
  }
  async insertApproval(a: Approval) { this.approvals.push(a); }
  async listApprovals(actionId: string) { return this.approvals.filter((a) => a.actionId === actionId); }

  async getSystemState() { return { ...this.state }; }
  async setPaused(paused: boolean, by: string, at: Date) {
    this.state = paused ? { paused, pausedBy: by, pausedAt: at } : { paused };
  }
  async audit(entry: AuditEntry) { this.auditLog.push(entry); }

  async getTenantByContact(contactId: string) { return this.tenants.find((t) => t.contactId === contactId) ?? null; }
  async getActiveLease(propertyId: string) {
    return this.leases.find((l) => l.propertyId === propertyId && l.status === "active") ?? null;
  }
  async listRequests(propertyId: string, opts?: { openOnly?: boolean }) {
    const closed = ["closed", "cancelled"];
    return this.requests.filter(
      (r) => r.propertyId === propertyId && (!opts?.openOnly || !closed.includes(r.status)),
    );
  }
  async getRequest(id: string) { return this.requests.find((r) => r.id === id) ?? null; }
  async insertRequest(r: Omit<MaintenanceRequest, "id">) {
    const request: MaintenanceRequest = { ...r, id: randomUUID() };
    this.requests.push(request);
    this.requestHistory.push({ requestId: request.id, to: request.status, actor: "agent", at: r.createdAt });
    return request;
  }
  async updateRequest(
    id: string, patch: Partial<Omit<MaintenanceRequest, "id" | "propertyId" | "createdAt">>,
    actor: "agent" | "owner" | "system", at: Date,
  ) {
    const request = this.requests.find((r) => r.id === id);
    if (!request) throw new Error(`request not found: ${id}`);
    if (patch.status && patch.status !== request.status) {
      this.requestHistory.push({ requestId: id, from: request.status, to: patch.status, actor, at });
    }
    Object.assign(request, patch);
    return request;
  }
  async listVendors() { return [...this.vendors]; }
  async getVendor(id: string) { return this.vendors.find((v) => v.id === id) ?? null; }
  async vendorHasPriorJob(vendorId: string) {
    return this.requests.some((r) => r.vendorId === vendorId && ["done", "closed"].includes(r.status));
  }
  async insertExpense(e: { propertyId: string; requestId?: string; vendorId?: string; category: string; amountCents: number; incurredOn: string }) {
    const row = { id: randomUUID(), amountCents: e.amountCents, requestId: e.requestId, vendorId: e.vendorId };
    this.expenses.push(row);
    return { id: row.id };
  }
  async insertCalendarEvent(e: { providerEventId: string; kind: "vendor_visit"; requestId?: string; startsAt: Date; endsAt: Date }) {
    const row = { id: randomUUID(), providerEventId: e.providerEventId, requestId: e.requestId, startsAt: e.startsAt };
    this.calendarEvents.push(row);
    return { id: row.id };
  }
}
