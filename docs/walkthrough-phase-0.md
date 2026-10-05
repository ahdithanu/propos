# Phase 0 walkthrough

Five questions an interviewer would ask about the scaffold, with honest answers.

## 1. How do you know every table is protected by RLS, and will that stay true?

A migration loop enables RLS and adds an owner policy on every public table, and
revokes all grants from `anon`. `tests/db/rls.test.ts` then checks the live
catalog: every table has RLS on and at least one policy, `anon` holds no grants,
a signed-in user who is not the owner sees zero rows in every table, and the
owner sees the data. Because the test reads the catalog rather than a list of
table names, a table added by a later migration without RLS fails CI.

Weak or unproven:
- The tests set the role and JWT claims inside a Postgres transaction. That is
  what PostgREST does, but no test goes through the actual HTTP API with a real
  anon or user token.
- "Has at least one policy" does not prove the policy is correct. A later
  migration could add `using (true)` and only the stranger-sees-zero-rows test
  would catch it, and only for tables that have rows in the seed. Eleven of the 24 tables
  are empty in the seed, so for them that test proves nothing.
- The service role bypasses RLS entirely. Workers are trusted; a bug in worker
  code is not contained by RLS.

## 2. What does "append-only" actually mean here, and who can still break it?

`audit_log` and `agent_steps` have triggers that reject update, delete and
truncate for every role, including the service role and the table owner. The
tests prove it for the service role and for `postgres`. `events` is different:
a trigger allows `status` and `emergency_hit` to change and rejects any other
change and all deletes, because the design called it append-only while also
giving it a status column.

Weak or unproven:
- Anyone who can run DDL can drop the trigger. This protects against application
  bugs, not against someone with database admin access.
- `request_history` and `approvals` are history tables too and are not guarded.
- `agent_runs` is mutable by design (status, token counts), so a run's recorded
  outcome can be rewritten.

## 3. Why is PII stored in plain text when the design called for encryption?

The design specified AES-GCM on phone, email, message bodies and memory, with
HMAC blind indexes for lookup and key-id prefixes for rotation. For one house
with fictional seed data on a local database, that is a lot of machinery before
anything works, and it makes every query and debug session harder. It was cut
for now; see D2 in `decisions.md`.

Weak or unproven:
- This is the largest gap between the design and the code. Nothing in the repo
  should hold real tenant data until it is revisited, which must happen before
  Phase 5.
- Adding it later is a migration and backfill, not a switch.
- The owner did not explicitly approve this cut; it was recommended and not
  objected to.

## 4. What do the policy and prompt loaders guarantee?

`loadPolicy` validates `policy.yaml` against a strict schema, so a misspelled
key is an error rather than a silently ignored setting, and a config file cannot
set a tool to Tier 3. It checks that every template's variables match its body
and that English and Spanish offer the same templates. It returns a hash over
policy and templates that is stable for equal content and changes when any value
changes. `loadPrompt` picks the highest version numerically, checks the front
matter against the path, and hashes the body so an edit without a version bump
is visible.

Weak or unproven:
- The hash covers the files only. Merging dashboard overrides, and hashing the
  merged result, is not built yet.
- Nothing prevents a tool from writing these files; that is a property the tool
  registry has to provide in Phase 1a. Today it is true only because no tools exist.
- The policy values are placeholders. No number in the file (caps, rate limits,
  spend cap) has been tested against real behaviour.
- Templates were written by an AI, including the Spanish. They need a read by a
  fluent speaker before a tenant sees them.

## 5. What does the seed represent and what is it missing?

One property, one Spanish-preferring tenant, one 12-month lease, three vendors,
a ledger from November 2025 to October 2026 that balances to zero with one late
month and a flat late fee, four closed maintenance requests with status history
and expenses, and two approved memory facts. Dates are fixed so results are
reproducible. Tests assert the counts, the twelve months, the zero balance and
the single late fee.

Weak or unproven:
- There are no events, threads, messages, runs or actions. Every table the
  harness writes to is empty, so nothing about realistic conversation history
  has been exercised.
- All four requests went through the same six status steps. No cancelled
  request, no missing-info loop, no request that changed vendor.
- The lease ends 2026-10-31, less than a month after the seed's "now". That is
  fine for maintenance work and will matter the moment renewals are in scope.
- The late fee amount and grace period are illustrative, not checked against
  California law.

## Also not verified in this phase

- The CI workflow has never run. It was written but nothing has been pushed.
- `npm run dev` was not opened in a browser; `next build` succeeds and the page
  is static.
