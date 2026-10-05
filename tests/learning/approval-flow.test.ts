/**
 * LEARNING MODE: owner SMS approval flow. Read docs/learning/approval-flow.md first.
 * Implement src/harness/approvals/flow.ts until this file is green.
 * (Needs parseOwnerSms from parser.ts.)
 */
import { describe, expect, it } from "vitest";
import { createHarness } from "@/harness";
import { handleOwnerSms } from "@/harness/approvals/flow";
import type { ApprovalDeps } from "@/harness/approvals/types";
import type { PolicyEvaluator } from "@/harness/policy/types";
import { CONTACTS, NOW, OWNER, createTestWorld } from "@/harness/testing";
import { ALL_TOOLS } from "@/tools";

const PLUMBER = CONTACTS.plumber.phone;
const TENANT = CONTACTS.tenant.phone;

// Stand-in tiers so actions can be created without the real policy engine.
const tiers: PolicyEvaluator = ({ tool }) => {
  const tier = tool.name === "send_free_text_message" ? 2 : tool.name === "send_template_message" ? 1 : 0;
  return { tier, reasons: tier ? [{ rule: "config_floor", tier }] : [] };
};

function setup() {
  const world = createTestWorld();
  const clock = { now: NOW };
  // Fixed code sequence (4821, 5932, 7300, 8290, ...) so no test can collide with a number it mentions.
  const rolls = [0.4246, 0.548, 0.7, 0.81];
  let roll = 0;
  const harness = createHarness({
    ...world, evaluate: tiers, tools: ALL_TOOLS, now: () => clock.now,
    random: () => rolls[roll++ % rolls.length]!,
  });
  const replies: string[] = [];
  const revisions: { actionId: string; instruction: string; sourceEventId: string }[] = [];
  const deps: ApprovalDeps = {
    store: world.store,
    execute: (id) => harness.outbox.execute(id),
    notifyOwner: async (text) => { replies.push(text); },
    enqueueRevision: async (job) => { revisions.push(job); },
    now: () => clock.now,
  };
  let run = 0;
  const ctx = () => harness.contextFor({ contact: CONTACTS.tenant, runId: `run-${++run}` });

  /** A Tier 2 action: free text to the plumber, awaiting approval. */
  const pending = async (body = "Can you come Friday at 10?") => {
    await harness.registry.call(ctx(), "send_free_text_message", { contact_id: "c-plumber", body });
    return world.store.actions.at(-1)!;
  };
  /** A Tier 1 action: templated message to the tenant, in its undo window. */
  const held = async () => {
    await harness.registry.call(ctx(), "send_template_message", {
      contact_id: "c-tenant", template_id: "request_more_info", vars: { first_name: "Maria", question: "¿Dónde?" },
    });
    return world.store.actions.at(-1)!;
  };
  let n = 0;
  const sms = (body: string, over: { from?: string; signatureValid?: boolean } = {}) =>
    handleOwnerSms(deps, { eventId: `ev-${++n}`, from: OWNER.phone, body, signatureValid: true, ...over });
  const advance = (minutes: number) => { clock.now = new Date(clock.now.getTime() + minutes * 60_000); };
  const status = (id: string) => world.store.actions.find((a) => a.id === id)!.status;
  return { ...world, harness, deps, replies, revisions, pending, held, sms, advance, status, clock };
}

describe("who may issue commands", () => {
  it("treats a valid-looking approval from any other number as ordinary text", async () => {
    const h = setup();
    const action = await h.pending();
    for (const from of [TENANT, PLUMBER, "+14085550199"]) {
      expect(await h.sms(`Y-${action.approvalCode}`, { from })).toEqual({ handled: false, reason: "not_owner" });
    }
    expect(h.status(action.id)).toBe("pending_approval");
    expect(h.store.approvals).toEqual([]);
    expect(h.replies).toEqual([]);
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(0);
  });

  it("requires a valid provider signature even from the owner's number", async () => {
    const h = setup();
    const action = await h.pending();
    expect(await h.sms(`Y-${action.approvalCode}`, { signatureValid: false })).toEqual({ handled: false, reason: "not_owner" });
    expect(h.status(action.id)).toBe("pending_approval");
  });

  it("matches the owner's number exactly, not loosely", async () => {
    const h = setup();
    const action = await h.pending();
    for (const from of ["4085550100", "+14085550100 ", "+1408555010", "+140855501000", ""]) {
      expect(await h.sms(`Y-${action.approvalCode}`, { from }), from).toEqual({ handled: false, reason: "not_owner" });
    }
    expect(h.status(action.id)).toBe("pending_approval");
  });

  it("does not let anyone else pause the system", async () => {
    const h = setup();
    expect(await h.sms("PAUSE", { from: TENANT })).toEqual({ handled: false, reason: "not_owner" });
    expect((await h.store.getSystemState()).paused).toBe(false);
  });

  it("passes ordinary owner messages on to the agent", async () => {
    const h = setup();
    await h.pending();
    expect(await h.sms("how's the plumber thing going?")).toEqual({ handled: false, reason: "not_a_command" });
    expect(await h.sms("see you in 2026")).toEqual({ handled: false, reason: "not_a_command" });
    expect(h.replies).toEqual([]);
  });
});

describe("approve", () => {
  it("executes the stored action and records the decision", async () => {
    const h = setup();
    const action = await h.pending("Can you come Friday at 10?");
    const result = await h.sms(`Y-${action.approvalCode}`);
    expect(result).toEqual({ handled: true, command: "approve", outcome: "approved_executed", actionId: action.id });
    expect(h.status(action.id)).toBe("executed");
    expect(h.ports.sms.to(PLUMBER).map((m) => m.body)).toEqual(["Can you come Friday at 10?"]);
    expect(h.store.approvals).toEqual([
      { actionId: action.id, channel: "sms", decision: "approve", ownerText: `Y-${action.approvalCode}`, decidedAt: NOW },
    ]);
    expect(h.replies).toHaveLength(1);
    expect(h.revisions).toEqual([]);
    expect(h.store.auditLog).toContainEqual(expect.objectContaining({ actor: "owner", entity: "action", entityId: action.id }));
  });

  it("sends once when the owner double-taps", async () => {
    const h = setup();
    const action = await h.pending();
    const first = await h.sms(`Y-${action.approvalCode}`);
    const second = await h.sms(`Y-${action.approvalCode}`);
    expect(first).toMatchObject({ outcome: "approved_executed" });
    expect(second.handled).toBe(true);
    expect(["already_decided", "unknown_code"]).toContain((second as { outcome: string }).outcome);
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(1);
    expect(h.store.approvals).toHaveLength(1);
  });

  it("sends once when two approvals arrive at the same moment", async () => {
    const h = setup();
    const action = await h.pending();
    await Promise.all([h.sms(`Y-${action.approvalCode}`), h.sms(`Y-${action.approvalCode}`)]);
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(1);
    expect(h.store.approvals.filter((a) => a.decision === "approve")).toHaveLength(1);
  });

  it("approves only the action whose code was sent", async () => {
    const h = setup();
    const a = await h.pending("first");
    const b = await h.pending("second");
    await h.sms(`Y-${b.approvalCode}`);
    expect(h.status(a.id)).toBe("pending_approval");
    expect(h.ports.sms.to(PLUMBER).map((m) => m.body)).toEqual(["second"]);
  });

  it("tells the owner when the code matches nothing, and changes nothing", async () => {
    const h = setup();
    const action = await h.pending();
    const wrong = action.approvalCode === "1111" ? "2222" : "1111";
    expect(await h.sms(`Y-${wrong}`)).toEqual({ handled: true, command: "approve", outcome: "unknown_code" });
    expect(h.status(action.id)).toBe("pending_approval");
    expect(h.replies).toHaveLength(1);
    expect(h.store.approvals).toEqual([]);
  });

  it("refuses an expired code even if no cleanup job has run yet", async () => {
    const h = setup();
    const action = await h.pending();
    h.advance(h.loaded.policy.approvals.code_ttl_hours * 60 + 1);
    expect(await h.sms(`Y-${action.approvalCode}`)).toMatchObject({ handled: true, outcome: "expired", actionId: action.id });
    expect(h.status(action.id)).toBe("expired");
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(0);
    expect(h.replies[0]).toMatch(/expired/i);
  });

  it("accepts a code up to the last moment before expiry", async () => {
    const h = setup();
    const action = await h.pending();
    h.advance(h.loaded.policy.approvals.code_ttl_hours * 60 - 1);
    expect(await h.sms(`Y-${action.approvalCode}`)).toMatchObject({ outcome: "approved_executed" });
  });

  it("records the approval but sends nothing while paused, and says so", async () => {
    const h = setup();
    const action = await h.pending();
    await h.store.setPaused(true, "owner", NOW);
    expect(await h.sms(`Y-${action.approvalCode}`)).toMatchObject({ outcome: "approved_blocked_paused" });
    expect(h.status(action.id)).toBe("blocked_paused");
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(0);
    expect(h.replies[0]).toMatch(/paused/i);
  });

  it("tells the owner when execution fails", async () => {
    const h = setup();
    const action = await h.pending();
    h.ports.sms.failAlways((m) => m.to === PLUMBER);
    expect(await h.sms(`Y-${action.approvalCode}`)).toMatchObject({ outcome: "approved_failed" });
    expect(h.status(action.id)).toBe("failed");
    expect(h.replies[0]).toMatch(/fail|could not|error/i);
  });

  it("does not release a held action early: Y is for approvals, not the undo window", async () => {
    const h = setup();
    const action = await h.held();
    expect(await h.sms(`Y-${action.approvalCode}`)).toMatchObject({ handled: true, outcome: "wrong_state" });
    expect(h.status(action.id)).toBe("held");
    expect(h.ports.sms.to(TENANT)).toHaveLength(0);
  });

  it("still applies the decision when the reply to the owner cannot be sent", async () => {
    const h = setup();
    const action = await h.pending();
    h.deps.notifyOwner = async () => { throw new Error("sms down"); };
    expect(await h.sms(`Y-${action.approvalCode}`)).toMatchObject({ outcome: "approved_executed" });
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(1);
  });
});

describe("reject", () => {
  it("closes the action for good", async () => {
    const h = setup();
    const action = await h.pending();
    expect(await h.sms(`N-${action.approvalCode}`)).toEqual({ handled: true, command: "reject", outcome: "rejected", actionId: action.id });
    expect(h.status(action.id)).toBe("rejected");
    expect(h.store.approvals).toMatchObject([{ decision: "reject" }]);
    await h.sms(`Y-${action.approvalCode}`);
    expect(h.status(action.id)).toBe("rejected");
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(0);
  });
});

describe("undo", () => {
  it("cancels a held action so it is never sent", async () => {
    const h = setup();
    const action = await h.held();
    expect(await h.sms(`U-${action.approvalCode}`)).toEqual({ handled: true, command: "undo", outcome: "undone", actionId: action.id });
    expect(h.status(action.id)).toBe("undone");
    expect(h.store.approvals).toMatchObject([{ decision: "undo" }]);
    h.advance(60);
    expect(await h.harness.outbox.releaseDue()).toEqual([]);
    expect(h.ports.sms.to(TENANT)).toHaveLength(0);
  });

  it("is honest when it is too late", async () => {
    const h = setup();
    const action = await h.held();
    h.advance(h.loaded.policy.undo_window_minutes + 1);
    await h.harness.outbox.releaseDue();
    const result = await h.sms(`U-${action.approvalCode}`);
    expect(result.handled).toBe(true);
    expect(["wrong_state", "unknown_code"]).toContain((result as { outcome: string }).outcome);
    expect(h.status(action.id)).toBe("executed");
    expect(h.replies).toHaveLength(1);
  });

  it("does not reject a pending approval: U is for the undo window only", async () => {
    const h = setup();
    const action = await h.pending();
    expect(await h.sms(`U-${action.approvalCode}`)).toMatchObject({ handled: true, outcome: "wrong_state" });
    expect(h.status(action.id)).toBe("pending_approval");
  });

  it("loses cleanly to a send that already started", async () => {
    const h = setup();
    const action = await h.held();
    h.advance(h.loaded.policy.undo_window_minutes + 1);
    await Promise.all([h.harness.outbox.releaseDue(), h.sms(`U-${action.approvalCode}`)]);
    const sent = h.ports.sms.to(TENANT).length;
    expect(h.status(action.id)).toBe(sent ? "executed" : "undone");
  });
});

describe("revise", () => {
  it("retires the old action and queues the owner's instruction for the agent", async () => {
    const h = setup();
    const action = await h.pending();
    const text = `${action.approvalCode} make it Thursday instead`;
    expect(await h.sms(text)).toEqual({ handled: true, command: "revise", outcome: "revision_queued", actionId: action.id });
    expect(h.status(action.id)).toBe("revising");
    expect(await h.store.findOpenActionByCode(action.approvalCode!)).toBeNull();
    expect(h.revisions).toHaveLength(1);
    expect(h.revisions[0]).toMatchObject({ actionId: action.id, instruction: text });
    expect(h.revisions[0]!.sourceEventId).toMatch(/^ev-/);
    expect(h.store.approvals).toMatchObject([{ decision: "edit", ownerText: text }]);
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(0);
  });

  it("means the original can no longer be approved as it was", async () => {
    const h = setup();
    const action = await h.pending();
    await h.sms(`${action.approvalCode} cap it at $300`);
    await h.sms(`Y-${action.approvalCode}`);
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(0);
  });

  it("treats 'approve, but...' as a revision, never as an approval", async () => {
    const h = setup();
    const action = await h.pending();
    expect(await h.sms(`Y-${action.approvalCode} but ask for Thursday`)).toMatchObject({ command: "revise", outcome: "revision_queued" });
    expect(h.ports.sms.to(PLUMBER)).toHaveLength(0);
  });

  it("picks the number that is an open code and ignores the other", async () => {
    const h = setup();
    const action = await h.pending();
    const other = action.approvalCode === "2500" ? "2600" : "2500";
    expect(await h.sms(`${action.approvalCode} make it ${other} max`)).toMatchObject({ outcome: "revision_queued", actionId: action.id });
  });
});

describe("pause, resume, status", () => {
  it("pauses and resumes, and is safe to repeat", async () => {
    const h = setup();
    expect(await h.sms("PAUSE")).toEqual({ handled: true, command: "pause", outcome: "paused" });
    expect(await h.sms("pause")).toMatchObject({ outcome: "paused" });
    expect(await h.store.getSystemState()).toMatchObject({ paused: true, pausedAt: NOW });
    expect(await h.sms("RESUME")).toEqual({ handled: true, command: "resume", outcome: "resumed" });
    expect((await h.store.getSystemState()).paused).toBe(false);
    expect(h.replies).toHaveLength(3);
    expect(h.store.auditLog.filter((a) => a.actor === "owner")).not.toHaveLength(0);
  });

  it("reports whether it is paused and lists what is waiting, with codes", async () => {
    const h = setup();
    const a = await h.pending("first");
    const b = await h.held();
    await h.sms("PAUSE");
    h.replies.length = 0;
    expect(await h.sms("STATUS")).toEqual({ handled: true, command: "status", outcome: "status_sent" });
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toMatch(/paused/i);
    expect(h.replies[0]).toContain(a.approvalCode);
    expect(h.replies[0]).toContain(b.approvalCode);
  });
});
