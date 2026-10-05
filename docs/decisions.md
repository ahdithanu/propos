# Decisions

Where this file and `design.md` disagree, this file wins. Newest at the bottom.

## Phase plan

| Phase | Contents | Status |
|---|---|---|
| 0 | Scaffold, schema with RLS, seed, loaders, CI | done |
| 1a | Learning-mode interfaces and failing tests (policy engine, emergency path, approval parser), then the deterministic harness around them | built; waiting on the owner's three implementations |
| 1b | Agent loop, Inngest wiring, memory tool, degraded mode, spend cap, integration tests | |
| 2 | Evals v1 | |
| 3 | Maintenance module | |
| 4 | Dashboard | |

Phases 5 and beyond are out of scope until the owner says otherwise.

## D1. Source documents
`CLAUDE.md` and `docs/deltas.md` named in the kickoff did not exist. The design
was the only input. The "open questions" it cites (Q1, Q4) were not in the file.

## D2. Field encryption is deferred
The design encrypts phone, email, bodies and memory with AES-GCM plus HMAC blind
indexes. For one house on a local database this was cut for now: those columns
are plain text. Redaction of logs and traces stays in scope (Phase 1a).
Consequence: the schema has `phone`, not `enc_phone` and `bidx_phone`, so adding
encryption later is a migration plus a backfill, not a config change.
**Not explicitly confirmed by the owner; recommended and not objected to.**

## D3. Tables and config dropped from the design
`comps`, `reminder_schedule`, `owner_tasks`, `eval_examples`,
`memory_categories_whitelist` (now `memory.categories` in `policy.yaml`),
`rate_counters` (rate limits count outbound rows in `messages`),
`policy/rent.yaml`, `policy/ca-compliance.yaml`, and module folders for phases
5 and beyond. **Same status as D2.**

## D4. No separate outbox row for event insert and enqueue
`events.status` is the outbox: a row stuck at `received` is found and re-enqueued
by a sweeper (Phase 1b). Scheduling is Inngest cron only, no pg_cron.

## D5. `events` is not fully append-only
The design calls it append-only but gives it a mutable `status`. A trigger allows
`status` and `emergency_hit` to change and rejects every other change and all
deletes, for every role.

## D6. Event insert comes before the emergency rules
The design's diagram runs emergency rules before the idempotent insert, so a
provider retry would resend the safety reply. Order is: verify, insert (dedupe),
emergency rules, loop detection, enqueue.

## D7. Kill switch and the emergency reply
Owner's answer was "pause on emergency". Recorded reading: **when paused, the
emergency safety reply to the tenant is also held; the owner alert still goes
out**, since messages to the owner are never paused. To be confirmed before the
Phase 1a emergency tests are written, because the tests encode it.

## D8. Emergency recall gate
Rules-only recall must be 100% on English and Spanish. Messages in other or
undetected languages are not in that gate; they trigger an owner alert instead.

## D9. Memory review gating
Agent-written facts are stored as `proposed` and only `active` facts are loaded
into context. `policy.yaml` `memory.require_review` controls this.

## D10. Seed is SQL, not `seed.ts`
`supabase db reset` runs `supabase/seed.sql` directly. Dates are fixed, not
relative to today, so tests and evals are reproducible.

## D11. Ledger sign convention
Charges are positive, payments and credits negative. Balance owed is the sum of
non-deposit rows. A database check enforces the sign per kind.

## D12. TypeScript 5, not 7
TypeScript 7 was the latest release at scaffold time; 5.9 was pinned to avoid
finding out mid-phase whether the lint and Next toolchain support it.

## D13. Tool list (the design never listed one)
Read: `get_tenant_profile`, `get_lease_summary`, `list_open_requests`, `list_vendors`, `get_thread_messages`.
Records (internal rows only): `create_maintenance_request`, `update_maintenance_request`, `log_expense`, `request_owner_review`.
Outbound: `send_ack` (code floor 0), `send_template_message` (floor 1), `send_free_text_message` (floor 2),
`alert_owner` (floor 0, owner only), `schedule_vendor_visit` (floor 2).
The memory tools come in Phase 1b. There is deliberately no tool for payments, signing or deleting.
**Proposed by the agent, not yet confirmed by the owner.**

## D14. Storage port, in-memory first
The harness talks to a `Store` interface. Phase 1a ships the in-memory implementation used by
tests and evals. The Postgres implementation is Phase 1b, with one shared behaviour suite run
against both. Until then nothing in `src/harness` has been exercised against the real schema.

## D15. Policy semantics the design left open
- Reads and record-keeping tools are Tier 0 unless config names them. The default tier applies to `action` tools only.
- `request_owner_review` raises later actions in that run to Tier 2; it does not block reads.
- Dashboard overrides are limited to the paths in `OVERRIDABLE_PATHS` plus per-tool tiers.
- A Tier 0 `send_ack` and `alert_owner` are set in `policy.yaml`; every other action defaults to Tier 2.

## D16. Approval commands
`Y`/`YES`, `N`/`NO`, `U`/`UNDO` plus a 4-digit code, as the whole message. Anything with extra
words is a revision, never an approval. `Y`/`N` act on pending approvals; `U` acts on held
(undo-window) actions. Codes are 1000 to 9999 and unique among open actions.

## D17. Kill switch scope
While paused, the executor blocks every action tool except those marked owner-directed, not only
messages. Blocked actions become `blocked_paused` and are not sent automatically on resume.

## D18. Learning-mode suites are validated but not shipped with an implementation
The three failing suites were run once against a throwaway reference implementation kept outside
the repo, to confirm they are satisfiable and not contradictory (252 of 252 passed). The reference
was then removed; the repo holds only stubs.
