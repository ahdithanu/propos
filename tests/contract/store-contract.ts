import { describe, expect, it } from "vitest";
import { ApprovalCodeTaken, type NewAction, type Store } from "@/harness/store";

/** Ids of rows the store under test already contains. */
export interface ContractWorld {
  store: Store;
  ownerContactId: string;
  ownerPhone: string;
  tenantContactId: string;
  tenantPhone: string;
  tenantEmail: string;
  tenantId: string;
  propertyId: string;
  plumberVendorId: string;
}

const T0 = new Date("2031-03-01T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let seq = 0;
const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

const action = (over: Partial<NewAction> = {}): NewAction => ({
  toolName: "send_free_text_message", args: { contact_id: "x", body: "hello" }, summary: "hello to x",
  effectiveTier: 2, tierReasons: ["config_floor:2"], status: "pending_approval", approvalCode: "4821",
  idempotencyKey: unique("key"), createdAt: T0, ...over,
});

/**
 * Behaviour every Store must have. Run against the in-memory store in the unit
 * project and against Postgres in the db project, so the two cannot drift.
 * `use` gives each test a fresh world and cleans up after it.
 */
export function storeContract(name: string, use: <T>(fn: (w: ContractWorld) => Promise<T>) => Promise<T>) {
  describe(`Store contract: ${name}`, () => {
    it("finds the owner and contacts by id, phone and email", () =>
      use(async (w) => {
        expect(await w.store.getOwner()).toMatchObject({ contactId: w.ownerContactId, phone: w.ownerPhone });
        expect((await w.store.findContactByPhone(w.tenantPhone))?.id).toBe(w.tenantContactId);
        expect((await w.store.findContactByEmail(w.tenantEmail.toUpperCase()))?.id).toBe(w.tenantContactId);
        expect(await w.store.getContact(w.tenantContactId)).toMatchObject({ kind: "tenant", preferredLanguage: "es" });
        expect(await w.store.findContactByPhone("+10000000000")).toBeNull();
        expect((await w.store.listContacts()).length).toBeGreaterThanOrEqual(5);
      }));

    it("treats malformed ids as not found instead of failing", () =>
      use(async (w) => {
        for (const bad of ["", "c-stranger", "'; drop table contacts; --", "123"]) {
          expect(await w.store.getContact(bad), bad).toBeNull();
          expect(await w.store.getAction(bad)).toBeNull();
          expect(await w.store.getEvent(bad)).toBeNull();
          expect(await w.store.getRequest(bad)).toBeNull();
          expect(await w.store.getVendor(bad)).toBeNull();
          expect(await w.store.getTenantByContact(bad)).toBeNull();
          expect(await w.store.vendorHasPriorJob(bad)).toBe(false);
        }
      }));

    it("inserts an event once per provider id", () =>
      use(async (w) => {
        const input = { type: "sms.inbound", source: "twilio" as const, externalId: unique("SM"), contactId: w.tenantContactId, payload: { body: "hola" }, receivedAt: T0 };
        const first = await w.store.insertEvent(input);
        const retry = await w.store.insertEvent({ ...input, payload: { body: "changed" } });
        expect(first.inserted).toBe(true);
        expect(retry).toMatchObject({ inserted: false, event: { id: first.event.id, payload: { body: "hola" } } });
        expect(first.event).toMatchObject({ status: "received", emergencyHit: false, contactId: w.tenantContactId });
        expect((await w.store.getEvent(first.event.id))?.receivedAt).toEqual(T0);
      }));

    it("moves event status and lets exactly one caller claim the emergency flag", () =>
      use(async (w) => {
        const { event } = await w.store.insertEvent({ type: "sms.inbound", source: "twilio", externalId: unique("SM"), payload: {}, receivedAt: T0 });
        expect(await w.store.markEmergencyHit(event.id)).toBe(true);
        expect(await w.store.markEmergencyHit(event.id)).toBe(false);
        expect((await w.store.listEventsByStatus("received", at(1))).map((e) => e.id)).toContain(event.id);
        expect((await w.store.listEventsByStatus("received", T0)).map((e) => e.id)).not.toContain(event.id);
        await w.store.setEventStatus(event.id, "queued");
        expect(await w.store.getEvent(event.id)).toMatchObject({ status: "queued", emergencyHit: true });
        expect((await w.store.listEventsByStatus("received", at(1))).map((e) => e.id)).not.toContain(event.id);
      }));

    it("keeps one thread per contact and channel and returns messages oldest first", () =>
      use(async (w) => {
        const thread = await w.store.getOrCreateThread("sms", w.tenantContactId);
        expect(await w.store.getOrCreateThread("sms", w.tenantContactId)).toBe(thread);
        expect(await w.store.getOrCreateThread("email", w.tenantContactId)).not.toBe(thread);
        const base = { threadId: thread, channel: "sms" as const, contactId: w.tenantContactId, redactedBody: "r", isAutoReply: false };
        await w.store.insertMessage({ ...base, direction: "outbound", body: "second", createdAt: at(2), templateId: "ack_received" });
        await w.store.insertMessage({ ...base, direction: "inbound", body: "first", createdAt: at(1) });
        await w.store.insertMessage({ ...base, direction: "outbound", body: "third", createdAt: at(3), templateId: "ack_received" });
        const mine = (await w.store.listThreadMessages(thread, at(0))).filter((m) => m.createdAt <= at(3));
        expect(mine.map((m) => m.body)).toEqual(["first", "second", "third"]);
        expect((await w.store.listThreadMessages(thread, at(2))).filter((m) => m.createdAt <= at(3)).map((m) => m.body)).toEqual(["second", "third"]);
        expect(await w.store.countOutbound(w.tenantContactId, "sms", at(3))).toBe(1);
        expect(await w.store.countOutbound(w.tenantContactId, "email", at(0))).toBe(0);
        expect(await w.store.lastOutboundTemplateAt(w.tenantContactId, "ack_received")).toEqual(at(3));
        expect(await w.store.lastOutboundTemplateAt(w.tenantContactId, "never_sent")).toBeNull();
      }));

    it("inserts an action once per idempotency key and round-trips its fields", () =>
      use(async (w) => {
        const input = action({ scopeContactId: w.tenantContactId, codeExpiresAt: at(60), args: { nested: { n: 1 }, list: ["a"] } });
        const first = await w.store.insertAction(input);
        const again = await w.store.insertAction({ ...input, summary: "different", approvalCode: "9999" });
        expect(first.inserted).toBe(true);
        expect(again).toMatchObject({ inserted: false, action: { id: first.action.id, summary: "hello to x", approvalCode: "4821" } });
        expect(await w.store.getAction(first.action.id)).toMatchObject({
          args: { nested: { n: 1 }, list: ["a"] }, effectiveTier: 2, tierReasons: ["config_floor:2"],
          scopeContactId: w.tenantContactId, codeExpiresAt: at(60), status: "pending_approval",
        });
      }));

    it("keeps approval codes unique among open actions only", () =>
      use(async (w) => {
        const { action: a } = await w.store.insertAction(action({ approvalCode: "7301" }));
        await expect(w.store.insertAction(action({ approvalCode: "7301", status: "held" }))).rejects.toBeInstanceOf(ApprovalCodeTaken);
        expect((await w.store.findOpenActionByCode("7301"))?.id).toBe(a.id);
        await w.store.transitionAction(a.id, ["pending_approval"], "rejected");
        expect(await w.store.findOpenActionByCode("7301")).toBeNull();
        const { action: b } = await w.store.insertAction(action({ approvalCode: "7301" }));
        expect((await w.store.findOpenActionByCode("7301"))?.id).toBe(b.id);
      }));

    it("transitions an action only from an expected status", () =>
      use(async (w) => {
        const { action: a } = await w.store.insertAction(action({ approvalCode: "7302" }));
        expect(await w.store.transitionAction(a.id, ["held", "approved"], "executing")).toBeNull();
        expect((await w.store.getAction(a.id))?.status).toBe("pending_approval");
        expect(await w.store.transitionAction(a.id, ["pending_approval"], "approved")).toMatchObject({ status: "approved" });
        expect(await w.store.transitionAction(a.id, ["pending_approval"], "rejected")).toBeNull();
        const done = await w.store.transitionAction(a.id, ["approved"], "executed", { executedResult: { sent: true } });
        expect(done).toMatchObject({ status: "executed", executedResult: { sent: true } });
        expect((await w.store.listActions({ status: ["executed"] })).map((x) => x.id)).toContain(a.id);
        expect((await w.store.listActions({ status: ["held"] })).map((x) => x.id)).not.toContain(a.id);
      }));

    it("records approvals", () =>
      use(async (w) => {
        const { action: a } = await w.store.insertAction(action({ approvalCode: "7303" }));
        await w.store.insertApproval({ actionId: a.id, channel: "sms", decision: "approve", ownerText: "Y-7303", decidedAt: T0 });
        expect(await w.store.listApprovals(a.id)).toEqual([
          { actionId: a.id, channel: "sms", decision: "approve", ownerText: "Y-7303", decidedAt: T0 },
        ]);
      }));

    it("rejects a second step with the same index", () =>
      use(async (w) => {
        const { event } = await w.store.insertEvent({ type: "sms.inbound", source: "twilio", externalId: unique("SM"), payload: {}, receivedAt: T0 });
        const run = await w.store.createRun({ eventId: event.id, promptName: "agent", promptVersion: 1, policyHash: "abc", model: "m", startedAt: T0 });
        await w.store.appendStep({ runId: run.id, idx: 0, type: "tool_call", toolName: "send_ack", input: {}, createdAt: at(0) });
        await expect(w.store.appendStep({ runId: run.id, idx: 0, type: "thought", createdAt: at(2) })).rejects.toThrow();
      }));

    it("finishes a run and reads it back", () =>
      use(async (w) => {
        const { event } = await w.store.insertEvent({ type: "sms.inbound", source: "twilio", externalId: unique("SM"), payload: {}, receivedAt: T0 });
        const before = await w.store.sumRunCostSince(at(-1));
        const run = await w.store.createRun({ eventId: event.id, promptName: "agent", promptVersion: 1, policyHash: "abc", model: "m", startedAt: T0 });
        await w.store.appendStep({ runId: run.id, idx: 1, type: "final", output: { outcome: "completed" }, createdAt: at(1) });
        await w.store.appendStep({ runId: run.id, idx: 0, type: "tool_call", toolName: "send_ack", input: { a: 1 }, createdAt: at(0) });
        await w.store.finishRun(run.id, { outcome: "completed", summary: "done", steps: 1, inputTokens: 1200, outputTokens: 80, costUsd: 0.0032, latencyMs: 900, finishedAt: at(1) });
        expect(await w.store.getRun(run.id)).toMatchObject({
          status: "finished", outcome: "completed", summary: "done", steps: 1, inputTokens: 1200, costUsd: 0.0032, latencyMs: 900,
        });
        expect((await w.store.listSteps(run.id)).map((s) => [s.idx, s.type, s.toolName])).toEqual([[0, "tool_call", "send_ack"], [1, "final", undefined]]);
        expect((await w.store.listSteps(run.id))[0]!.input).toEqual({ a: 1 });
        expect((await w.store.sumRunCostSince(at(-1))) - before).toBeCloseTo(0.0032, 6);
        expect(await w.store.sumRunCostSince(at(1))).toBe(0);
      }));

    it("returns memory facts by exact status", () =>
      use(async (w) => {
        const base = { scope: "tenant" as const, subjectId: w.tenantId, category: "tone", ownerEdited: false, createdAt: T0 };
        await w.store.insertMemoryFact({ ...base, fact: "contract proposed", status: "proposed" });
        await w.store.insertMemoryFact({ ...base, fact: "contract active", status: "active" });
        const active = (await w.store.listMemoryFacts("tenant", w.tenantId, "active")).map((f) => f.fact);
        const proposed = (await w.store.listMemoryFacts("tenant", w.tenantId, "proposed")).map((f) => f.fact);
        expect(active).toContain("contract active");
        expect(active).not.toContain("contract proposed");
        expect(proposed).toContain("contract proposed");
        expect(await w.store.listMemoryFacts("property", w.tenantId, "active")).toEqual([]);
      }));

    it("pauses and resumes", () =>
      use(async (w) => {
        await w.store.setPaused(true, "owner", T0);
        expect(await w.store.getSystemState()).toEqual({ paused: true, pausedBy: "owner", pausedAt: T0 });
        await w.store.setPaused(false, "owner", at(1));
        expect((await w.store.getSystemState()).paused).toBe(false);
        expect((await w.store.getSystemState()).pausedAt).toBeUndefined();
      }));

    it("reads the tenant, the lease as plain dates, and vendor history", () =>
      use(async (w) => {
        expect(await w.store.getTenantByContact(w.tenantContactId)).toMatchObject({ id: w.tenantId, propertyId: w.propertyId });
        expect(await w.store.getTenantByContact(w.ownerContactId)).toBeNull();
        expect(await w.store.getActiveLease(w.propertyId)).toMatchObject({ startDate: "2025-11-01", endDate: "2026-10-31", dueDay: 1, monthlyRentCents: 320000 });
        expect(await w.store.vendorHasPriorJob(w.plumberVendorId)).toBe(true);
        expect((await w.store.getVendor(w.plumberVendorId))?.trades).toEqual(["plumbing"]);
        expect((await w.store.listVendors()).length).toBe(3);
      }));

    it("creates, updates and filters maintenance requests", () =>
      use(async (w) => {
        const created = await w.store.insertRequest({
          propertyId: w.propertyId, tenantId: w.tenantId, title: "Contract leak", category: "plumbing",
          urgency: "routine", urgencyReason: "drip", status: "info_needed", missingInfo: ["where?"], createdAt: T0,
        });
        expect((await w.store.listRequests(w.propertyId, { openOnly: true })).map((r) => r.id)).toContain(created.id);
        const updated = await w.store.updateRequest(created.id, { status: "scheduled", vendorId: w.plumberVendorId, quoteCents: 18500, missingInfo: [], scheduledStart: at(600) }, "agent", at(5));
        expect(updated).toMatchObject({ status: "scheduled", vendorId: w.plumberVendorId, quoteCents: 18500, missingInfo: [], title: "Contract leak", scheduledStart: at(600) });
        await w.store.updateRequest(created.id, { status: "closed", closedAt: at(900) }, "owner", at(900));
        expect((await w.store.listRequests(w.propertyId, { openOnly: true })).map((r) => r.id)).not.toContain(created.id);
        expect((await w.store.listRequests(w.propertyId)).map((r) => r.id)).toContain(created.id);
        expect((await w.store.getRequest(created.id))?.closedAt).toEqual(at(900));
        await expect(w.store.updateRequest("00000000-0000-4000-8000-00000000dead", { status: "closed" }, "agent", T0)).rejects.toThrow(/not found/);
      }));

    it("records expenses, calendar events, audit entries and dead letters without error", () =>
      use(async (w) => {
        expect((await w.store.insertExpense({ propertyId: w.propertyId, vendorId: w.plumberVendorId, category: "plumbing", amountCents: 18500, incurredOn: "2031-03-01" })).id).toBeTruthy();
        expect((await w.store.insertCalendarEvent({ providerEventId: unique("CAL"), kind: "vendor_visit", startsAt: at(60), endsAt: at(120) })).id).toBeTruthy();
        await w.store.audit({ at: T0, actor: "system", action: "contract.test", entity: "none", details: { ok: true } });
        await w.store.insertDeadLetter({ jobName: "process-event", error: "boom", attempts: 3 });
      }));
  });
}
