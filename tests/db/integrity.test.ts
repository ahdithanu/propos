import { describe, expect, it } from "vitest";
import { actAs, failure, inRolledBackTx } from "./helpers";

const INSERT_EVENT =
  "insert into events (type, source, external_id, payload) values ('sms.inbound', 'twilio', $1, $2) " +
  "on conflict (source, external_id) do nothing returning id";

describe("events", () => {
  it("treats a provider retry as a no-op", async () => {
    await inRolledBackTx(async (db) => {
      await actAs(db, "service_role");
      const first = await db.query(INSERT_EVENT, ["SM-dup", { body: "hello" }]);
      const retry = await db.query(INSERT_EVENT, ["SM-dup", { body: "hello" }]);
      expect(first.rowCount).toBe(1);
      expect(retry.rowCount).toBe(0);
    });
  });

  it("allows status changes but never content changes or deletes, even for the service role", async () => {
    await inRolledBackTx(async (db) => {
      await actAs(db, "service_role");
      await db.query(INSERT_EVENT, ["SM-guard", { body: "original" }]);
      const where = "where external_id = 'SM-guard'";
      const ok = await db.query(`update events set status = 'queued', emergency_hit = true ${where}`);
      expect(ok.rowCount).toBe(1);
      expect((await failure(db, `update events set payload = '{"body":"edited"}' ${where}`)).message)
        .toMatch(/only status and emergency_hit may change/);
      expect((await failure(db, `delete from events ${where}`)).message).toMatch(/cannot be removed/);
    });
  });
});

describe("append-only tables", () => {
  it("reject update, delete and truncate for the service role and the table owner", async () => {
    await inRolledBackTx(async (db) => {
      await db.query("insert into audit_log (actor, action, entity) values ('system', 'test', 'none')");
      for (const role of ["service_role", null] as const) {
        if (role) await actAs(db, role);
        else await db.query("reset role");
        for (const sql of [
          "update audit_log set actor = 'rewritten'",
          "delete from audit_log",
          "truncate audit_log",
          "truncate agent_steps",
        ]) {
          expect((await failure(db, sql)).message, `${role ?? "postgres"}: ${sql}`)
            .toMatch(/append-only/);
        }
      }
    });
  });
});

describe("actions", () => {
  const insert = (key: string, status: string) =>
    `insert into actions (tool_name, args, effective_tier, status, approval_code, idempotency_key)
     values ('send_sms', '{}', 2, '${status}', '4821', '${key}')`;

  it("keeps an approval code unique among open actions and reusable once closed", async () => {
    await inRolledBackTx(async (db) => {
      await db.query(insert("a", "pending_approval"));
      expect((await failure(db, insert("b", "held"))).message).toMatch(/actions_open_code_idx/);
      await db.query("update actions set status = 'executed' where idempotency_key = 'a'");
      await db.query(insert("c", "pending_approval"));
    });
  });

  it("refuses a second action with the same idempotency key", async () => {
    await inRolledBackTx(async (db) => {
      await db.query(insert("same", "executed"));
      expect((await failure(db, insert("same", "executed"))).message).toMatch(/idempotency_key/);
    });
  });
});

describe("system_state", () => {
  it("is a single row", async () => {
    await inRolledBackTx(async (db) => {
      const { rows } = await db.query("select paused from system_state");
      expect(rows).toEqual([{ paused: false }]);
      await failure(db, "insert into system_state default values");
    });
  });
});

describe("seed", () => {
  it("has one property, tenant and lease, three vendors and four closed requests", async () => {
    await inRolledBackTx(async (db) => {
      const { rows } = await db.query(`
        select (select count(*)::int from properties) as properties,
               (select count(*)::int from tenants) as tenants,
               (select count(*)::int from leases) as leases,
               (select count(*)::int from vendors) as vendors,
               (select count(*)::int from maintenance_requests where status = 'closed') as requests,
               (select count(*)::int from request_history) as history,
               (select count(*)::int from expenses) as expenses`);
      expect(rows[0]).toEqual({
        properties: 1, tenants: 1, leases: 1, vendors: 3, requests: 4, history: 24, expenses: 4,
      });
    });
  });

  it("has twelve months of ledger that balance to zero, with one late month", async () => {
    await inRolledBackTx(async (db) => {
      const { rows } = await db.query(`
        select count(distinct period) filter (where kind = 'rent_charge')::int as months,
               min(period) as first, max(period) as last,
               sum(amount_cents) filter (where kind <> 'deposit')::int as balance,
               count(*) filter (where kind = 'late_fee')::int as late_fees
        from ledger_entries`);
      expect(rows[0]).toEqual({
        months: 12, first: "2025-11", last: "2026-10", balance: 0, late_fees: 1,
      });
    });
  });
});
