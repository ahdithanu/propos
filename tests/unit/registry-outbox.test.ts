import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "@/harness";
import type { PolicyEvaluator, PolicyInput } from "@/harness/policy/types";
import { defineTool, type ToolDef } from "@/harness/registry";
import { CONTACTS, NOW, OWNER, createTestWorld } from "@/harness/testing";
import type { Tier } from "@/harness/types";
import { ALL_TOOLS } from "@/tools";

/**
 * A stand-in for the policy engine: tier by tool name, nothing else. These
 * tests are about routing a decision, not about making one.
 */
function fixedTiers(tiers: Record<string, Tier>, seen: PolicyInput[] = []): PolicyEvaluator {
  return (input) => {
    seen.push(input);
    const tier = tiers[input.tool.name] ?? 0;
    return { tier, reasons: tier ? [{ rule: "config_floor", tier }] : [] };
  };
}

function setup(tiers: Record<string, Tier> = {}, extraTools: ToolDef[] = []) {
  const world = createTestWorld();
  const clock = { now: NOW };
  const seen: PolicyInput[] = [];
  let n = 0;
  const harness = createHarness({
    store: world.store, ports: world.ports, loaded: world.loaded, evaluate: fixedTiers(tiers, seen),
    tools: [...ALL_TOOLS, ...extraTools], now: () => clock.now,
    random: () => (n++ * 0.1234567) % 1,
  });
  const ctx = (contact: keyof typeof CONTACTS = "tenant", runId = "run-1") =>
    harness.contextFor({ contact: CONTACTS[contact], runId });
  const advance = (minutes: number) => { clock.now = new Date(clock.now.getTime() + minutes * 60_000); };
  return { ...world, ...harness, ctx, seen, advance };
}

const ownerTexts = (ports: ReturnType<typeof setup>["ports"]) => ports.sms.to(OWNER.phone).map((m) => m.body);
const codeIn = (text: string, prefix: string) => new RegExp(`${prefix}-(\\d{4})`).exec(text)?.[1];

describe("registry", () => {
  it("rejects unknown tools and invalid args without consulting policy or executing", async () => {
    const h = setup();
    expect(await h.registry.call(h.ctx(), "wire_money", {})).toMatchObject({ status: "error", error: "unknown_tool" });
    expect(await h.registry.call(h.ctx(), "send_free_text_message", { contact_id: "c-tenant" }))
      .toMatchObject({ status: "error", error: "invalid_args" });
    expect(await h.registry.call(h.ctx(), "send_ack", { to: "+15550001111" }))
      .toMatchObject({ status: "error", error: "invalid_args" });
    expect(h.seen).toHaveLength(0);
    expect(h.ports.sms.sent).toHaveLength(0);
  });

  it("runs Tier 0 reads inline and returns schema-checked output with no contact details", async () => {
    const h = setup();
    const result = await h.registry.call(h.ctx(), "list_vendors", { trade: "plumbing" });
    expect(result).toMatchObject({ status: "ok", output: [{ name: "Bayline Plumbing", has_prior_job: true }] });
    expect(JSON.stringify(result)).not.toMatch(/555|@/);
    expect(h.store.actions).toHaveLength(0);
  });

  it("writes an audit entry with redacted args for every evaluated call", async () => {
    const h = setup({ send_free_text_message: 2 });
    await h.registry.call(h.ctx(), "send_free_text_message", { contact_id: "c-tenant", body: "Call 408-555-0121" });
    const entry = h.store.auditLog.find((a) => a.action === "tool.call");
    expect(entry).toMatchObject({ entityId: "send_free_text_message", details: { tier: 2 } });
    expect(JSON.stringify(entry)).not.toContain("555-0121");
  });

  it("gives the engine facts it computed itself, and the tool's code-declared floor", async () => {
    const h = setup({ send_free_text_message: 2 });
    await h.registry.call(h.ctx(), "send_free_text_message", {
      contact_id: "c-electrician", body: "Maria's number is 408-555-0111, the lease says you can enter",
    });
    expect(h.seen[0]).toMatchObject({
      tool: { name: "send_free_text_message", kind: "action", baseTier: 2 },
      agentRequestedReview: false,
      facts: {
        recipient: { known: true, kind: "vendor", isOwner: false, isEventContact: false, vendorHasPriorJob: false },
        templateId: null, sensitive: true, containsOtherPartyPii: true,
      },
    });
  });

  it("reports an unknown recipient to the engine instead of failing earlier", async () => {
    const h = setup({ send_free_text_message: 3 });
    const result = await h.registry.call(h.ctx(), "send_free_text_message", { contact_id: "c-stranger", body: "hi" });
    expect(h.seen[0]!.facts.recipient).toEqual({ known: false, isOwner: false, isEventContact: false });
    expect(result.status).toBe("refused");
  });

  it("makes request_owner_review sticky for the rest of that run only", async () => {
    const h = setup();
    await h.registry.call(h.ctx("tenant", "run-1"), "request_owner_review", { reason: "not sure" });
    await h.registry.call(h.ctx("tenant", "run-1"), "send_ack", {});
    await h.registry.call(h.ctx("tenant", "run-2"), "send_ack", {});
    const acks = h.seen.filter((s) => s.tool.name === "send_ack");
    expect(acks.map((s) => s.agentRequestedReview)).toEqual([true, false]);
  });

  it("caps calls per tool per run", async () => {
    const h = setup();
    expect((await h.registry.call(h.ctx(), "send_ack", {})).status).toBe("ok");
    expect(await h.registry.call(h.ctx(), "send_ack", {})).toMatchObject({ status: "error", error: "call_limit" });
    expect(h.ports.sms.to(CONTACTS.tenant.phone)).toHaveLength(1);
  });

  it("fails closed to Tier 3 when the policy engine throws or returns nonsense", async () => {
    for (const broken of [
      () => { throw new Error("boom"); },
      () => ({ tier: 7, reasons: [] }),
      () => undefined,
    ] as unknown as PolicyEvaluator[]) {
      const world = createTestWorld();
      const h = createHarness({ ...world, evaluate: broken, tools: ALL_TOOLS, now: () => NOW });
      const result = await h.registry.call(h.contextFor({ contact: CONTACTS.tenant, runId: "r" }), "send_ack", {});
      expect(result.status).toBe("refused");
      expect(world.ports.sms.to(CONTACTS.tenant.phone)).toHaveLength(0);
    }
  });

  it("times out a slow tool", async () => {
    const slow = defineTool({
      name: "slow_read", description: "", kind: "read", baseTier: 0, timeoutMs: 20,
      input: z.strictObject({}), output: z.object({}),
      execute: () => new Promise((resolve) => setTimeout(() => resolve({}), 200)),
    }) as unknown as ToolDef;
    const h = setup({}, [slow]);
    expect(await h.registry.call(h.ctx(), "slow_read", {})).toMatchObject({ status: "error", error: "timeout" });
  });
});

describe("tool scoping", () => {
  it("keeps a vendor's thread from seeing other vendors or any tenant data", async () => {
    const h = setup();
    const vendors = await h.registry.call(h.ctx("plumber"), "list_vendors", {});
    expect(vendors).toMatchObject({ status: "ok", output: [{ name: "Bayline Plumbing" }] });
    expect((vendors as { output: unknown[] }).output).toHaveLength(1);
    for (const tool of ["get_lease_summary", "list_open_requests"]) {
      expect(await h.registry.call(h.ctx("plumber"), tool, {})).toMatchObject({ status: "error", error: "out_of_scope" });
    }
  });

  it("refuses to touch a request outside the triggering tenant's property", async () => {
    const h = setup();
    h.store.requests.push({
      id: "r-other", propertyId: "p-other", title: "Other house", category: "plumbing", urgency: "routine",
      status: "new", missingInfo: [], createdAt: NOW,
    });
    expect(await h.registry.call(h.ctx(), "update_maintenance_request", { request_id: "r-other", status: "closed" }))
      .toMatchObject({ status: "error", error: "out_of_scope" });
    expect(h.store.requests.find((r) => r.id === "r-other")!.status).toBe("new");
  });

  it("creates a request and records the status history", async () => {
    const h = setup();
    const created = await h.registry.call(h.ctx(), "create_maintenance_request", {
      title: "Dishwasher leaking", category: "appliance", urgency: "routine",
      urgency_reason: "Small puddle, contained", missing_info: ["Which side is the leak on?"],
    });
    expect(created).toMatchObject({ status: "ok", output: { status: "info_needed" } });
    expect(h.store.requestHistory.at(-1)).toMatchObject({ to: "info_needed" });
  });
});

describe("outbox routing", () => {
  it("Tier 0: sends now, in the tenant's language", async () => {
    const h = setup();
    expect(await h.registry.call(h.ctx(), "send_ack", {})).toMatchObject({ status: "ok", tier: 0 });
    expect(h.ports.sms.to(CONTACTS.tenant.phone)[0]!.body).toMatch(/^Hola Maria/);
    expect(h.store.actions).toMatchObject([{ status: "executed", effectiveTier: 0 }]);
  });

  it("Tier 1: holds for the undo window, tells the owner how to undo, then sends", async () => {
    const h = setup({ send_template_message: 1 });
    const args = { contact_id: "c-tenant", template_id: "request_more_info", vars: { first_name: "Maria", question: "¿Dónde está la fuga?" } };
    const result = await h.registry.call(h.ctx(), "send_template_message", args);
    expect(result).toMatchObject({ status: "held", tier: 1 });
    const code = h.store.actions[0]!.approvalCode!;
    expect(JSON.stringify(result)).not.toContain(code); // the model never learns the code
    expect(h.ports.sms.to(CONTACTS.tenant.phone)).toHaveLength(0);
    expect(codeIn(ownerTexts(h.ports)[0]!, "U")).toBe(code);

    h.advance(h.loaded.policy.undo_window_minutes - 1);
    expect(await h.outbox.releaseDue()).toEqual([]);
    h.advance(1);
    expect(await h.outbox.releaseDue()).toMatchObject([{ status: "executed" }]);
    expect(h.ports.sms.to(CONTACTS.tenant.phone)[0]!.body).toContain("¿Dónde está la fuga?");
    expect(await h.outbox.releaseDue()).toEqual([]);
  });

  it("Tier 1: an undo before the window closes means it is never sent", async () => {
    const h = setup({ send_template_message: 1 });
    await h.registry.call(h.ctx(), "send_template_message", {
      contact_id: "c-tenant", template_id: "request_more_info", vars: { first_name: "Maria", question: "x" },
    });
    await h.store.transitionAction(h.store.actions[0]!.id, ["held"], "undone");
    h.advance(60);
    expect(await h.outbox.releaseDue()).toEqual([]);
    expect(h.ports.sms.to(CONTACTS.tenant.phone)).toHaveLength(0);
  });

  it("Tier 2: stores validated args, asks the owner with a code, and sends nothing", async () => {
    const h = setup({ send_free_text_message: 2 });
    const result = await h.registry.call(h.ctx(), "send_free_text_message", { contact_id: "c-plumber", body: "Can you come Friday?" });
    expect(result).toMatchObject({ status: "pending_approval", tier: 2 });
    const action = h.store.actions[0]!;
    expect(action).toMatchObject({ status: "pending_approval", args: { contact_id: "c-plumber", body: "Can you come Friday?" } });
    expect(action.codeExpiresAt!.getTime() - NOW.getTime()).toBe(h.loaded.policy.approvals.code_ttl_hours * 3600_000);
    expect(ownerTexts(h.ports)[0]).toBe(
      `Approve? "Can you come Friday?" to vendor Bayline Plumbing. Reply Y-${action.approvalCode} or N-${action.approvalCode}.`,
    );
    expect(h.ports.sms.to(CONTACTS.plumber.phone)).toHaveLength(0);
  });

  it("Tier 2: once approved, executes the stored args exactly once", async () => {
    const h = setup({ send_free_text_message: 2 });
    await h.registry.call(h.ctx(), "send_free_text_message", { contact_id: "c-plumber", body: "Can you come Friday?" });
    const id = h.store.actions[0]!.id;
    expect(await h.outbox.execute(id)).toMatchObject({ status: "skipped" }); // not approved yet
    await h.store.transitionAction(id, ["pending_approval"], "approved");
    const [a, b] = await Promise.all([h.outbox.execute(id), h.outbox.execute(id)]);
    expect([a.status, b.status].sort()).toEqual(["executed", "skipped"]);
    expect(h.ports.sms.to(CONTACTS.plumber.phone)).toHaveLength(1);
  });

  it("Tier 2: unanswered approvals expire and can no longer be executed", async () => {
    const h = setup({ send_free_text_message: 2 });
    await h.registry.call(h.ctx(), "send_free_text_message", { contact_id: "c-plumber", body: "hi" });
    h.advance(h.loaded.policy.approvals.code_ttl_hours * 60 + 1);
    expect(await h.outbox.expireStale()).toHaveLength(1);
    expect(h.store.actions[0]!.status).toBe("expired");
    expect(await h.store.findOpenActionByCode(h.store.actions[0]!.approvalCode!)).toBeNull();
  });

  it("Tier 3: refuses, tells the owner, and never executes", async () => {
    const h = setup({ send_free_text_message: 3 });
    const result = await h.registry.call(h.ctx(), "send_free_text_message", { contact_id: "c-plumber", body: "hi" });
    expect(result).toMatchObject({ status: "refused", tier: 3 });
    expect(ownerTexts(h.ports)[0]).toMatch(/^Refused/);
    expect(await h.outbox.execute(h.store.actions[0]!.id)).toMatchObject({ status: "skipped" });
    expect(h.ports.sms.to(CONTACTS.plumber.phone)).toHaveLength(0);
  });

  it("gives every open action a different code", async () => {
    const world = createTestWorld();
    // A generator that wants the same code three times before moving on.
    const rolls = [0.5, 0.5, 0.5, 0.25];
    const h2 = createHarness({
      ...world, evaluate: fixedTiers({ send_free_text_message: 2 }), tools: ALL_TOOLS, now: () => NOW,
      random: () => rolls.shift() ?? 0.9,
    });
    const ctx = h2.contextFor({ contact: CONTACTS.tenant, runId: "r" });
    await h2.registry.call(ctx, "send_free_text_message", { contact_id: "c-plumber", body: "one" });
    await h2.registry.call(ctx, "send_free_text_message", { contact_id: "c-plumber", body: "two" });
    expect(world.store.actions.map((a) => a.approvalCode)).toEqual(["5500", "3250"]);
  });

  it("does not create or announce a duplicate when the same call repeats in a run", async () => {
    const h = setup({ send_free_text_message: 2 });
    const args = { contact_id: "c-plumber", body: "Can you come Friday?" };
    await h.registry.call(h.ctx(), "send_free_text_message", args);
    expect(await h.registry.call(h.ctx(), "send_free_text_message", args)).toMatchObject({ status: "pending_approval" });
    expect(h.store.actions).toHaveLength(1);
    expect(ownerTexts(h.ports)).toHaveLength(1);
  });
});

describe("kill switch", () => {
  it("stops a held action at send time even though it was queued before the pause", async () => {
    const h = setup({ send_template_message: 1 });
    await h.registry.call(h.ctx(), "send_template_message", {
      contact_id: "c-tenant", template_id: "request_more_info", vars: { first_name: "Maria", question: "x" },
    });
    await h.store.setPaused(true, "owner", NOW);
    h.advance(30);
    expect(await h.outbox.releaseDue()).toEqual([{ status: "blocked_paused" }]);
    expect(h.store.actions[0]!.status).toBe("blocked_paused");
    expect(h.ports.sms.to(CONTACTS.tenant.phone)).toHaveLength(0);
  });

  it("blocks non-message actions too, but still lets the agent reach the owner", async () => {
    const h = setup();
    await h.store.setPaused(true, "owner", NOW);
    h.store.requests.push({
      id: "r-open", propertyId: "p-maple", title: "Leak", category: "plumbing", urgency: "routine",
      status: "new", missingInfo: [], createdAt: NOW,
    });
    const visit = await h.registry.call(h.ctx(), "schedule_vendor_visit", {
      request_id: "r-open", vendor_id: "v-plumber", starts_at: "2026-10-07T17:00:00Z",
    });
    expect(visit.status).toBe("blocked_paused");
    expect(h.ports.calendar.events).toHaveLength(0);
    expect(await h.registry.call(h.ctx(), "send_ack", {})).toMatchObject({ status: "blocked_paused" });
    expect(await h.registry.call(h.ctx(), "alert_owner", { text: "Tenant wrote in while paused" })).toMatchObject({ status: "ok" });
    expect(ownerTexts(h.ports)).toEqual(["Tenant wrote in while paused"]);
  });

  it("lets a blocked action run after resume", async () => {
    const h = setup();
    await h.store.setPaused(true, "owner", NOW);
    await h.registry.call(h.ctx(), "send_ack", {});
    await h.store.setPaused(false, "owner", NOW);
    expect(await h.outbox.execute(h.store.actions[0]!.id)).toMatchObject({ status: "executed" });
    expect(h.ports.sms.to(CONTACTS.tenant.phone)).toHaveLength(1);
  });
});

describe("scheduling a vendor visit", () => {
  it("books the mock calendar, updates the request and passes the quote as an amount fact", async () => {
    const h = setup();
    h.store.requests.push({
      id: "r-open", propertyId: "p-maple", title: "Leak", category: "plumbing", urgency: "routine",
      status: "quoted", missingInfo: [], createdAt: NOW,
    });
    const result = await h.registry.call(h.ctx(), "schedule_vendor_visit", {
      request_id: "r-open", vendor_id: "v-plumber", starts_at: "2026-10-07T17:00:00Z", quote_cents: 18500,
    });
    expect(result).toMatchObject({ status: "ok", output: { request_status: "scheduled" } });
    expect(h.seen.at(-1)!.facts).toMatchObject({ amountCents: 18500, recipient: { kind: "vendor", vendorHasPriorJob: true } });
    expect(h.ports.calendar.events).toMatchObject([{ title: "Vendor visit: Leak" }]);
    expect(h.store.requests.find((r) => r.id === "r-open")).toMatchObject({ status: "scheduled", vendorId: "v-plumber", quoteCents: 18500 });
  });
});
