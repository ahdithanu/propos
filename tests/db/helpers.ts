import { Client } from "pg";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

export const OWNER_USER_ID = "00000000-0000-4000-8000-000000000001";
export const STRANGER_USER_ID = "99999999-9999-4999-8999-999999999999";

/** Runs fn inside a transaction that is always rolled back, so tests leave no rows. */
export async function inRolledBackTx<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    await db.query("begin");
    return await fn(db);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

/** Switches the transaction to a Supabase API role, as PostgREST would for a request. */
export async function actAs(
  db: Client,
  role: "anon" | "authenticated" | "service_role",
  userId?: string,
) {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(userId ? { sub: userId, role } : { role }),
  ]);
  await db.query(`set local role ${role}`);
}

/** Runs sql expecting it to fail; returns the error and keeps the transaction usable. */
export async function failure(db: Client, sql: string, params: unknown[] = []): Promise<Error> {
  await db.query("savepoint expect_failure");
  try {
    await db.query(sql, params);
  } catch (err) {
    await db.query("rollback to savepoint expect_failure");
    return err as Error;
  }
  throw new Error(`Expected statement to fail but it succeeded: ${sql}`);
}

export async function publicTables(db: Client): Promise<string[]> {
  const { rows } = await db.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by 1",
  );
  return rows.map((r) => r.tablename);
}
