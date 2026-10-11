import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MockLlm, call } from "@/adapters/mocks/llm";
import { createMockPorts } from "@/adapters/mocks";
import { PgStore } from "@/adapters/postgres/store";
import { loadPolicy } from "@/config/policy";
import { loadPrompt } from "@/config/prompts";
import { createHarness } from "@/harness";
import { runAgent } from "@/harness/agent";
import { ingestInbound } from "@/harness/ingest";
import { ApprovalCodeTaken } from "@/harness/store";
import { ALL_TOOLS } from "@/tools";
import { DATABASE_URL, SEED, inRolledBackTx } from "./helpers";

/**
 * These tests use a real connection pool and committed rows, because the point
 * is what happens when separate connections race. Rows they create use unique
 * ids and stay behind until the next `npm run db:reset`.
 */
const pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
const store = new PgStore(pool);
afterAll(() => pool.end());

const NOW = new Date("2031-06-01T12:00:00Z");
const PARALLEL = 20;
const times = <T>(fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: PARALLEL }, (_, i) => fn(i)));

describe("Postgres store under real concurrency", () => {
  it("lets exactly one of many callers win an action transition", async () => {
    const { action } = await store.insertAction({
      toolName: "t", args: {}, summary: "race", effectiveTier: 2, tierReasons: [], status: "approved",
      idempotencyKey: `race-${randomUUID()}`, createdAt: NOW,
    });
    const results = await times(() => store.transitionAction(action.id, ["approved"], "executing"));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("inserts a retried provider event once", async () => {
    const externalId = `SM-race-${randomUUID()}`;
    const results = await times(() => store.insertEvent({ type: "sms.inbound", source: "twilio", externalId, payload: {}, receivedAt: NOW }));
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(new Set(results.map((r) => r.event.id)).size).toBe(1);
  });

  it("lets exactly one caller claim the emergency flag", async () => {
    const { event } = await store.insertEvent({ type: "sms.inbound", source: "twilio", externalId: `SM-${randomUUID()}`, payload: {}, receivedAt: NOW });
    const results = await times(() => store.markEmergencyHit(event.id));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("inserts an action once per idempotency key", async () => {
    const idempotencyKey = `idem-${randomUUID()}`;
    const results = await times(() => store.insertAction({
      toolName: "t", args: {}, summary: "idem", effectiveTier: 0, tierReasons: [], status: "approved", idempotencyKey, createdAt: NOW,
    }));
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(new Set(results.map((r) => r.action.id)).size).toBe(1);
  });

  it("gives one approval code to one open action", async () => {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    const settled = await Promise.allSettled(Array.from({ length: PARALLEL }, () => store.insertAction({
      toolName: "t", args: {}, summary: "code", effectiveTier: 2, tierReasons: [], status: "pending_approval",
      approvalCode: code, idempotencyKey: `code-${randomUUID()}`, createdAt: NOW,
    })));
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost.every((s) => (s as PromiseRejectedResult).reason instanceof ApprovalCodeTaken)).toBe(true);
    // Close it so a later run can draw the same code.
    await store.transitionAction((won[0] as PromiseFulfilledResult<{ action: { id: string } }>).value.action.id, ["pending_approval"], "expired");
  });

  it("creates one default thread when first messages arrive together", async () => {
    const ids = await times(() => store.getOrCreateThread("email", SEED.tenantContactId));
    expect(new Set(ids).size).toBe(1);
  });
});

describe("the harness on the real schema", () => {
  it("ingests a message, runs the agent and leaves the trace and a pending approval in Postgres", () =>
    inRolledBackTx(async (db) => {
      const pg = new PgStore(db);
      const loaded = loadPolicy();
      const ports = createMockPorts();
      const now = () => NOW;
      const harness = createHarness({
        store: pg, ports, loaded, tools: ALL_TOOLS, now,
        // Stand-in for the policy engine: free text needs approval, everything else runs.
        evaluate: ({ tool }) => (tool.name === "send_free_text_message"
          ? { tier: 2, reasons: [{ rule: "free_text", tier: 2 }] } : { tier: 0, reasons: [] }),
      });
      const queued: string[] = [];
      const ingested = await ingestInbound(
        {
          store: pg, getPolicy: () => loaded.policy, now,
          handleEmergency: async () => ({ hit: false, tenantReply: "not_applicable", ownerAlert: "not_applicable" }),
          enqueue: async (id) => { queued.push(id); },
        },
        { source: "twilio", externalId: `SM-${randomUUID()}`, channel: "sms", from: SEED.tenantPhone, body: "La llave de la cocina gotea, mi cel es 408-555-0111" },
      );
      expect(ingested.status).toBe("queued");

      const plumber = "00000000-0000-4000-8000-000000000021";
      const llm = new MockLlm([
        [
          call("create_maintenance_request", { title: "Faucet dripping again", category: "plumbing", urgency: "routine", urgency_reason: "Slow drip" }),
          call("send_ack"),
          call("send_free_text_message", { contact_id: plumber, body: "Can you look at a dripping faucet this week?" }),
        ],
        [call("finish", { outcome: "completed", summary: "Opened a request, acknowledged, and asked the owner to approve a note to the plumber." })],
      ]);
      const run = await runAgent({ store: pg, ports, llm, harness, loaded, prompt: loadPrompt("agent"), now }, queued[0]!);
      expect(run).toMatchObject({ status: "finished", outcome: "completed", steps: 3 });

      const { rows: steps } = await db.query("select type, tool_name, effective_tier from agent_steps where run_id = $1 order by idx", [run.id]);
      expect(steps.map((s) => s.type)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "final"]);
      expect(steps[5]).toMatchObject({ tool_name: "send_free_text_message", effective_tier: 2 });

      const { rows: actions } = await db.query("select tool_name, status, approval_code, scope_contact_id from actions where run_id = $1 order by created_at, tool_name", [run.id]);
      expect(actions).toEqual([
        { tool_name: "send_ack", status: "executed", approval_code: null, scope_contact_id: SEED.tenantContactId },
        expect.objectContaining({ tool_name: "send_free_text_message", status: "pending_approval", approval_code: expect.stringMatching(/^\d{4}$/) }),
      ]);
      const { rows: requests } = await db.query("select status from maintenance_requests where title = 'Faucet dripping again'");
      expect(requests).toEqual([{ status: "new" }]);
      const { rows: event } = await db.query("select status from events where id = $1", [queued[0]]);
      expect(event).toEqual([{ status: "done" }]);

      expect(ports.sms.to(SEED.tenantPhone)).toHaveLength(1);
      expect(ports.sms.to("+14085550121")).toHaveLength(0);
      expect(ports.sms.to(SEED.ownerPhone)[0]!.body).toMatch(/^Approve\? .* Reply Y-\d{4} or N-\d{4}\.$/);
      // Nothing the model saw, and nothing in the stored trace, contains the phone number the tenant typed.
      expect(llm.seen()).not.toContain("555-0111");
      const { rows: trace } = await db.query("select redacted_input, redacted_output from agent_steps where run_id = $1", [run.id]);
      expect(JSON.stringify(trace)).not.toContain("555-0111");
    }));
});
