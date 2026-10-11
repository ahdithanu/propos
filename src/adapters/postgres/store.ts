import { types } from "pg";
import { ApprovalCodeTaken, type NewAction, type NewEvent, type NewMessage, type Store } from "@/harness/store";
import type {
  Action, ActionStatus, AgentRun, AgentStep, Approval, AuditEntry, Channel, Contact, EventStatus,
  HarnessEvent, Lease, MaintenanceRequest, MemoryFact, MemoryScope, Message, Owner, SystemState,
  Tenant, Vendor,
} from "@/harness/types";

// Keep `date` columns as "YYYY-MM-DD" strings; the default parser builds a local-midnight Date.
types.setTypeParser(1082, (v) => v);

/** A pg Pool, or a single Client (tests run inside one rolled-back transaction). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

type Row = Record<string, unknown>;
const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));

const toContact = (r: Row): Contact => ({
  id: r.id as string, kind: r.kind as Contact["kind"], displayName: r.display_name as string,
  firstName: opt(r.first_name), phone: opt(r.phone), email: opt(r.email),
  preferredChannel: r.preferred_channel as Channel, preferredLanguage: r.preferred_language as string,
  isAllowlisted: r.is_allowlisted as boolean,
});
const toEvent = (r: Row): HarnessEvent => ({
  id: r.id as string, type: r.type as string, source: r.source as HarnessEvent["source"],
  externalId: r.external_id as string, contactId: opt(r.contact_id), payload: r.payload as Record<string, unknown>,
  status: r.status as EventStatus, emergencyHit: r.emergency_hit as boolean, receivedAt: r.received_at as Date,
});
const toMessage = (r: Row): Message => ({
  id: r.id as string, threadId: r.thread_id as string, eventId: opt(r.event_id),
  direction: r.direction as Message["direction"], channel: r.channel as Channel, contactId: r.contact_id as string,
  body: r.body as string, redactedBody: r.redacted_body as string, providerId: opt(r.provider_id),
  templateId: opt(r.template_id), isAutoReply: r.is_auto_reply as boolean, createdAt: r.created_at as Date,
});
const toAction = (r: Row): Action => ({
  id: r.id as string, runId: opt(r.run_id), scopeContactId: opt(r.scope_contact_id), toolName: r.tool_name as string,
  args: r.args, summary: r.summary as string, effectiveTier: r.effective_tier as Action["effectiveTier"],
  tierReasons: r.tier_reasons as string[], status: r.status as ActionStatus, approvalCode: opt(r.approval_code),
  codeExpiresAt: opt(r.code_expires_at), sendAt: opt(r.send_at), idempotencyKey: r.idempotency_key as string,
  executedResult: opt(r.executed_result), parentActionId: opt(r.parent_action_id), createdAt: r.created_at as Date,
});
const toRequest = (r: Row): MaintenanceRequest => ({
  id: r.id as string, propertyId: r.property_id as string, tenantId: opt(r.tenant_id), title: r.title as string,
  category: r.category as string, urgency: r.urgency as MaintenanceRequest["urgency"], urgencyReason: opt(r.urgency_reason),
  status: r.status as MaintenanceRequest["status"], missingInfo: r.missing_info as string[], vendorId: opt(r.vendor_id),
  quoteCents: opt(r.quote_cents), scheduledStart: opt(r.scheduled_start), createdAt: r.created_at as Date,
  closedAt: opt(r.closed_at),
});
const toVendor = (r: Row): Vendor => ({
  id: r.id as string, contactId: r.contact_id as string, trades: r.trades as string[],
  preapproved: r.preapproved as boolean, autoSpendLimitCents: r.auto_spend_limit_cents as number,
  rating: opt(r.rating), notes: opt(r.notes),
});
const toRun = (r: Row): AgentRun => ({
  id: r.id as string, eventId: r.event_id as string, promptName: r.prompt_name as string,
  promptVersion: r.prompt_version as number, policyHash: r.policy_hash as string, model: r.model as string,
  status: r.status as AgentRun["status"], outcome: opt(r.outcome), escalationReason: opt(r.escalation_reason),
  summary: opt(r.summary), steps: r.steps as number, inputTokens: r.input_tokens as number,
  outputTokens: r.output_tokens as number, costUsd: Number(r.cost_usd), latencyMs: opt(r.latency_ms),
  startedAt: r.started_at as Date, finishedAt: opt(r.finished_at),
});
const toFact = (r: Row): MemoryFact => ({
  id: r.id as string, scope: r.scope as MemoryScope, subjectId: r.subject_id as string, category: r.category as string,
  fact: r.fact as string, sourceRunId: opt(r.source_run_id), status: r.status as MemoryFact["status"],
  ownerEdited: r.owner_edited as boolean, createdAt: r.created_at as Date,
});

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

// Ids can come from a model. A malformed one must read as "not found", not as a database error.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/**
 * Store backed by the Supabase Postgres schema. Connect with the service role
 * or the postgres role; RLS is for the dashboard, not for workers. Every
 * compare-and-set method is a single statement, so it is atomic without a transaction.
 */
export class PgStore implements Store {
  constructor(private db: Queryable) {}

  private async one(text: string, params: unknown[] = []): Promise<Row | null> {
    return (await this.db.query(text, params)).rows[0] ?? null;
  }
  private async many(text: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.db.query(text, params)).rows;
  }

  async getOwner(): Promise<Owner> {
    const r = await this.one(
      `select c.id, o.phone, o.email from app_owner o join contacts c on c.phone = o.phone and c.kind = 'owner' limit 1`,
    );
    if (!r) throw new Error("no owner configured (app_owner with a matching owner contact)");
    return { contactId: r.id as string, phone: r.phone as string, email: r.email as string };
  }
  async getContact(id: string) {
    if (!isUuid(id)) return null;
    const r = await this.one("select * from contacts where id = $1", [id]);
    return r && toContact(r);
  }
  async findContactByPhone(phone: string) {
    const r = await this.one("select * from contacts where phone = $1", [phone]);
    return r && toContact(r);
  }
  async findContactByEmail(email: string) {
    const r = await this.one("select * from contacts where lower(email) = lower($1)", [email]);
    return r && toContact(r);
  }
  async listContacts() {
    return (await this.many("select * from contacts order by created_at, id")).map(toContact);
  }

  async insertEvent(e: NewEvent) {
    const inserted = await this.one(
      `insert into events (type, source, external_id, contact_id, payload, received_at)
       values ($1, $2, $3, $4, $5, $6) on conflict (source, external_id) do nothing returning *`,
      [e.type, e.source, e.externalId, e.contactId ?? null, json(e.payload), e.receivedAt],
    );
    if (inserted) return { event: toEvent(inserted), inserted: true };
    const existing = await this.one("select * from events where source = $1 and external_id = $2", [e.source, e.externalId]);
    return { event: toEvent(existing!), inserted: false };
  }
  async getEvent(id: string) {
    if (!isUuid(id)) return null;
    const r = await this.one("select * from events where id = $1", [id]);
    return r && toEvent(r);
  }
  async setEventStatus(id: string, status: EventStatus) {
    const r = await this.db.query("update events set status = $2 where id = $1", [id, status]);
    if (!r.rowCount) throw new Error(`event not found: ${id}`);
  }
  async markEmergencyHit(eventId: string) {
    const r = await this.db.query(
      "update events set emergency_hit = true where id = $1 and emergency_hit = false", [eventId],
    );
    return r.rowCount === 1;
  }
  async listEventsByStatus(status: EventStatus, olderThan: Date) {
    return (await this.many(
      "select * from events where status = $1 and received_at < $2 order by received_at", [status, olderThan],
    )).map(toEvent);
  }

  async getOrCreateThread(channel: Channel, contactId: string) {
    const r = await this.one(
      `insert into threads (channel, contact_id) values ($1, $2)
       on conflict (channel, contact_id) where external_thread_id is null
       do update set channel = excluded.channel returning id`,
      [channel, contactId],
    );
    return r!.id as string;
  }
  async insertMessage(m: NewMessage) {
    const r = await this.one(
      `with msg as (
         insert into messages (thread_id, event_id, direction, channel, contact_id, body, redacted_body,
                               provider_id, template_id, is_auto_reply, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *),
       touch as (update threads set last_message_at = $11 where id = $1)
       select * from msg`,
      [m.threadId, m.eventId ?? null, m.direction, m.channel, m.contactId, m.body, m.redactedBody,
       m.providerId ?? null, m.templateId ?? null, m.isAutoReply, m.createdAt],
    );
    return toMessage(r!);
  }
  async listThreadMessages(threadId: string, since?: Date) {
    return (await this.many(
      "select * from messages where thread_id = $1 and ($2::timestamptz is null or created_at >= $2) order by created_at, id",
      [threadId, since ?? null],
    )).map(toMessage);
  }
  async countOutbound(contactId: string, channel: Channel, since: Date) {
    const r = await this.one(
      `select count(*)::int as n from messages
       where direction = 'outbound' and contact_id = $1 and channel = $2 and created_at >= $3`,
      [contactId, channel, since],
    );
    return r!.n as number;
  }
  async lastOutboundTemplateAt(contactId: string, templateId: string) {
    const r = await this.one(
      `select max(created_at) as at from messages
       where direction = 'outbound' and contact_id = $1 and template_id = $2`,
      [contactId, templateId],
    );
    return (r?.at as Date | null) ?? null;
  }

  async insertAction(a: NewAction) {
    // No conflict target: this absorbs a clash on the idempotency key and on the
    // open-approval-code index alike, and we then work out which one it was.
    const inserted = await this.one(
      `insert into actions (run_id, scope_contact_id, tool_name, args, summary, effective_tier, tier_reasons,
                            status, approval_code, code_expires_at, send_at, idempotency_key, executed_result,
                            parent_action_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict do nothing returning *`,
      [a.runId ?? null, a.scopeContactId ?? null, a.toolName, json(a.args), a.summary, a.effectiveTier,
       a.tierReasons, a.status, a.approvalCode ?? null, a.codeExpiresAt ?? null, a.sendAt ?? null,
       a.idempotencyKey, json(a.executedResult), a.parentActionId ?? null, a.createdAt],
    );
    if (inserted) return { action: toAction(inserted), inserted: true };
    const existing = await this.one("select * from actions where idempotency_key = $1", [a.idempotencyKey]);
    if (existing) return { action: toAction(existing), inserted: false };
    throw new ApprovalCodeTaken(a.approvalCode ?? "");
  }
  async getAction(id: string) {
    if (!isUuid(id)) return null;
    const r = await this.one("select * from actions where id = $1", [id]);
    return r && toAction(r);
  }
  async findOpenActionByCode(code: string) {
    const r = await this.one(
      "select * from actions where approval_code = $1 and status in ('held', 'pending_approval')", [code],
    );
    return r && toAction(r);
  }
  async listActions(filter?: { status?: ActionStatus[] }) {
    return (await this.many(
      "select * from actions where ($1::text[] is null or status = any($1)) order by created_at, id",
      [filter?.status ?? null],
    )).map(toAction);
  }
  async transitionAction(
    id: string, from: ActionStatus[], to: ActionStatus,
    patch?: Partial<Pick<Action, "executedResult" | "sendAt">>,
  ) {
    // One statement: the row lock makes concurrent callers queue, and only the
    // first still sees a status in `from`.
    const r = await this.one(
      `update actions set status = $3,
              executed_result = coalesce($4::jsonb, executed_result),
              send_at = coalesce($5, send_at)
       where id = $1 and status = any($2) returning *`,
      [id, from, to, json(patch?.executedResult), patch?.sendAt ?? null],
    );
    return r && toAction(r);
  }
  async insertApproval(a: Approval) {
    await this.db.query(
      "insert into approvals (action_id, channel, decision, owner_text, decided_at) values ($1, $2, $3, $4, $5)",
      [a.actionId, a.channel, a.decision, a.ownerText ?? null, a.decidedAt],
    );
  }
  async listApprovals(actionId: string) {
    return (await this.many("select * from approvals where action_id = $1 order by decided_at, id", [actionId])).map(
      (r): Approval => ({
        actionId: r.action_id as string, channel: r.channel as Approval["channel"],
        decision: r.decision as Approval["decision"], ownerText: opt(r.owner_text), decidedAt: r.decided_at as Date,
      }),
    );
  }

  async createRun(r: Omit<AgentRun, "id" | "status" | "steps" | "inputTokens" | "outputTokens" | "costUsd">) {
    const row = await this.one(
      `insert into agent_runs (event_id, prompt_name, prompt_version, policy_hash, model, started_at)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [r.eventId, r.promptName, r.promptVersion, r.policyHash, r.model, r.startedAt],
    );
    return toRun(row!);
  }
  async appendStep(s: AgentStep) {
    await this.db.query(
      `insert into agent_steps (run_id, idx, type, tool_name, redacted_input, redacted_output, effective_tier,
                                tier_reasons, duration_ms, input_tokens, output_tokens, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [s.runId, s.idx, s.type, s.toolName ?? null, json(s.input), json(s.output), s.effectiveTier ?? null,
       s.tierReasons ?? [], s.durationMs ?? null, s.inputTokens ?? null, s.outputTokens ?? null, s.createdAt],
    );
  }
  async finishRun(id: string, x: Partial<AgentRun>) {
    const r = await this.db.query(
      `update agent_runs set status = 'finished', outcome = $2, escalation_reason = $3, summary = $4, steps = $5,
              input_tokens = $6, output_tokens = $7, cost_usd = $8, latency_ms = $9, finished_at = $10
       where id = $1`,
      [id, x.outcome ?? null, x.escalationReason ?? null, x.summary ?? null, x.steps ?? 0, x.inputTokens ?? 0,
       x.outputTokens ?? 0, x.costUsd ?? 0, x.latencyMs ?? null, x.finishedAt ?? null],
    );
    if (!r.rowCount) throw new Error(`run not found: ${id}`);
  }
  async getRun(id: string) {
    if (!isUuid(id)) return null;
    const r = await this.one("select * from agent_runs where id = $1", [id]);
    return r && toRun(r);
  }
  async listSteps(runId: string) {
    return (await this.many("select * from agent_steps where run_id = $1 order by idx", [runId])).map(
      (r): AgentStep => ({
        runId: r.run_id as string, idx: r.idx as number, type: r.type as AgentStep["type"], toolName: opt(r.tool_name),
        input: opt(r.redacted_input), output: opt(r.redacted_output), effectiveTier: opt(r.effective_tier),
        tierReasons: r.tier_reasons as string[], durationMs: opt(r.duration_ms), inputTokens: opt(r.input_tokens),
        outputTokens: opt(r.output_tokens), createdAt: r.created_at as Date,
      }),
    );
  }
  async sumRunCostSince(since: Date) {
    const r = await this.one("select coalesce(sum(cost_usd), 0) as total from agent_runs where started_at >= $1", [since]);
    return Number(r!.total);
  }
  async insertDeadLetter(d: { jobName: string; eventId?: string; error: string; attempts: number }) {
    await this.db.query(
      "insert into dead_letters (job_name, event_id, error, attempts) values ($1, $2, $3, $4)",
      [d.jobName, d.eventId ?? null, d.error, d.attempts],
    );
  }

  async listMemoryFacts(scope: MemoryScope, subjectId: string, status: MemoryFact["status"]) {
    return (await this.many(
      "select * from memory_facts where scope = $1 and subject_id = $2 and status = $3 order by created_at, id",
      [scope, subjectId, status],
    )).map(toFact);
  }
  async insertMemoryFact(f: Omit<MemoryFact, "id">) {
    const r = await this.one(
      `insert into memory_facts (scope, subject_id, category, fact, source_run_id, status, owner_edited, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [f.scope, f.subjectId, f.category, f.fact, f.sourceRunId ?? null, f.status, f.ownerEdited, f.createdAt],
    );
    return toFact(r!);
  }

  async getSystemState(): Promise<SystemState> {
    const r = await this.one("select * from system_state");
    return { paused: r!.paused as boolean, pausedAt: opt(r!.paused_at), pausedBy: opt(r!.paused_by) };
  }
  async setPaused(paused: boolean, by: string, at: Date) {
    await this.db.query(
      "update system_state set paused = $1, paused_at = case when $1 then $3::timestamptz end, paused_by = case when $1 then $2 end",
      [paused, by, at],
    );
  }
  async audit(e: AuditEntry) {
    await this.db.query(
      "insert into audit_log (at, actor, action, entity, entity_id, details, run_id) values ($1, $2, $3, $4, $5, $6, $7)",
      [e.at, e.actor, e.action, e.entity, e.entityId ?? null, json(e.details), e.runId ?? null],
    );
  }

  async getTenantByContact(contactId: string): Promise<Tenant | null> {
    if (!isUuid(contactId)) return null;
    const r = await this.one("select * from tenants where contact_id = $1", [contactId]);
    return r && { id: r.id as string, contactId: r.contact_id as string, propertyId: r.property_id as string, status: r.status as Tenant["status"] };
  }
  async getActiveLease(propertyId: string): Promise<Lease | null> {
    const r = await this.one(
      "select * from leases where property_id = $1 and status = 'active' order by start_date desc limit 1", [propertyId],
    );
    return r && {
      id: r.id as string, propertyId: r.property_id as string, startDate: r.start_date as string,
      endDate: r.end_date as string, monthlyRentCents: r.monthly_rent_cents as number, dueDay: r.due_day as number,
      graceDays: r.grace_days as number, status: r.status as Lease["status"],
    };
  }
  async listRequests(propertyId: string, opts?: { openOnly?: boolean }) {
    return (await this.many(
      `select * from maintenance_requests
       where property_id = $1 and (not $2 or status not in ('closed', 'cancelled')) order by created_at, id`,
      [propertyId, opts?.openOnly ?? false],
    )).map(toRequest);
  }
  async getRequest(id: string) {
    if (!isUuid(id)) return null;
    const r = await this.one("select * from maintenance_requests where id = $1", [id]);
    return r && toRequest(r);
  }
  async insertRequest(q: Omit<MaintenanceRequest, "id">) {
    const r = await this.one(
      `with req as (
         insert into maintenance_requests (property_id, tenant_id, title, category, urgency, urgency_reason, status,
                                           missing_info, vendor_id, quote_cents, scheduled_start, created_at, closed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *),
       hist as (
         insert into request_history (request_id, to_status, actor, at) select id, status, 'agent', created_at from req)
       select * from req`,
      [q.propertyId, q.tenantId ?? null, q.title, q.category, q.urgency, q.urgencyReason ?? null, q.status,
       q.missingInfo, q.vendorId ?? null, q.quoteCents ?? null, q.scheduledStart ?? null, q.createdAt, q.closedAt ?? null],
    );
    return toRequest(r!);
  }
  async updateRequest(
    id: string, p: Partial<Omit<MaintenanceRequest, "id" | "propertyId" | "createdAt">>,
    actor: "agent" | "owner" | "system", at: Date,
  ) {
    const r = await this.one(
      `with before as (select status from maintenance_requests where id = $1 for update),
       upd as (
         update maintenance_requests set
           status = coalesce($2, status), urgency = coalesce($3, urgency),
           missing_info = coalesce($4::text[], missing_info), vendor_id = coalesce($5, vendor_id),
           quote_cents = coalesce($6, quote_cents), scheduled_start = coalesce($7, scheduled_start),
           closed_at = coalesce($8, closed_at), title = coalesce($9, title), category = coalesce($10, category),
           urgency_reason = coalesce($11, urgency_reason)
         where id = $1 returning *),
       hist as (
         insert into request_history (request_id, from_status, to_status, actor, at)
         select upd.id, before.status, upd.status, $12, $13 from upd, before where upd.status <> before.status)
       select * from upd`,
      [id, p.status ?? null, p.urgency ?? null, p.missingInfo ?? null, p.vendorId ?? null, p.quoteCents ?? null,
       p.scheduledStart ?? null, p.closedAt ?? null, p.title ?? null, p.category ?? null, p.urgencyReason ?? null, actor, at],
    );
    if (!r) throw new Error(`request not found: ${id}`);
    return toRequest(r);
  }
  async listVendors() {
    return (await this.many("select * from vendors order by id")).map(toVendor);
  }
  async getVendor(id: string) {
    if (!isUuid(id)) return null;
    const r = await this.one("select * from vendors where id = $1", [id]);
    return r && toVendor(r);
  }
  async vendorHasPriorJob(vendorId: string) {
    if (!isUuid(vendorId)) return false;
    const r = await this.one(
      "select exists (select 1 from maintenance_requests where vendor_id = $1 and status in ('done', 'closed')) as yes",
      [vendorId],
    );
    return r!.yes as boolean;
  }
  async insertExpense(e: { propertyId: string; requestId?: string; vendorId?: string; category: string; amountCents: number; incurredOn: string }) {
    const r = await this.one(
      `insert into expenses (property_id, request_id, vendor_id, category, amount_cents, incurred_on)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [e.propertyId, e.requestId ?? null, e.vendorId ?? null, e.category, e.amountCents, e.incurredOn],
    );
    return { id: r!.id as string };
  }
  async insertCalendarEvent(e: { providerEventId: string; kind: "vendor_visit"; requestId?: string; startsAt: Date; endsAt: Date }) {
    const r = await this.one(
      `insert into calendar_events (google_event_id, kind, request_id, starts_at, ends_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [e.providerEventId, e.kind, e.requestId ?? null, e.startsAt, e.endsAt],
    );
    return { id: r!.id as string };
  }
}
