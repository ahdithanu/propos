import { describe, expect, it } from "vitest";
import {
  OWNER_USER_ID,
  STRANGER_USER_ID,
  actAs,
  failure,
  inRolledBackTx,
  publicTables,
} from "./helpers";

describe("row level security", () => {
  it("is enabled, with at least one policy, on every public table", async () => {
    await inRolledBackTx(async (db) => {
      const { rows } = await db.query<{ table: string; rls: boolean; policies: number }>(`
        select c.relname as table, c.relrowsecurity as rls,
               (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`);
      expect(rows.length).toBeGreaterThan(20);
      expect(rows.filter((r) => !r.rls || r.policies === 0)).toEqual([]);
    });
  });

  it("gives the anon role no privileges on any table", async () => {
    await inRolledBackTx(async (db) => {
      const { rows } = await db.query(`
        select table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'anon'`);
      expect(rows).toEqual([]);
      await actAs(db, "anon");
      const err = await failure(db, "select * from properties");
      expect(err.message).toMatch(/permission denied/);
    });
  });

  it("shows a signed-in user who is not the owner zero rows in every table", async () => {
    await inRolledBackTx(async (db) => {
      const tables = await publicTables(db);
      await actAs(db, "authenticated", STRANGER_USER_ID);
      for (const table of tables) {
        const { rows } = await db.query(`select count(*)::int as n from public."${table}"`);
        expect(rows[0].n, table).toBe(0);
      }
      // An update is not an error under RLS; it simply matches no rows.
      const { rowCount } = await db.query("update system_state set paused = true");
      expect(rowCount).toBe(0);
      const insert = await failure(
        db,
        "insert into contacts (kind, display_name) values ('vendor', 'Injected')",
      );
      expect(insert.message).toMatch(/row-level security/);
    });
  });

  it("lets the owner read and modify operational tables", async () => {
    await inRolledBackTx(async (db) => {
      await actAs(db, "authenticated", OWNER_USER_ID);
      const { rows } = await db.query("select nickname from properties");
      expect(rows).toEqual([{ nickname: "Maple House" }]);
      const { rowCount } = await db.query("update system_state set paused = true");
      expect(rowCount).toBe(1);
    });
  });

  it("lets the owner read but not write the append-only tables", async () => {
    await inRolledBackTx(async (db) => {
      await actAs(db, "authenticated", OWNER_USER_ID);
      await db.query("select * from audit_log");
      for (const sql of [
        "insert into audit_log (actor, action, entity) values ('owner', 'x', 'y')",
        "insert into events (type, source, external_id, payload) values ('sms', 'twilio', 'SM1', '{}')",
        "delete from agent_steps",
      ]) {
        expect((await failure(db, sql)).message, sql).toMatch(/permission denied/);
      }
    });
  });
});
