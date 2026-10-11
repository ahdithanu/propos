# PropOps

Agent harness for one owner and one California single-family rental. The design
is `docs/design.md`; where this repo differs from it, `docs/decisions.md` wins.

## Commands

- `npm run dev` / `build` / `lint` / `typecheck`
- `npm test` — unit tests, no services needed
- `npm run test:learning` — the owner's three learning-mode suites (red until implemented)
- `npm run test:integration` — webhook to agent to approval on mocks (red until the same three exist)
- `npm run evals:ci` — eval gates on scripted models (free; red until the same three exist)
- `npm run evals -- --model claude-sonnet-5-5` — live-model evals. Costs money: ask the owner first.
- `npm run db:start` then `npm run test:db` — database tests against local Supabase
- `npm run db:reset` — reapply all migrations and the seed

Local Supabase uses ports 544xx (API 54421, Postgres 54422, Studio 54423), not
the default 543xx, so it can run next to other local projects.

## Rules that must hold

- Tiers are computed in code by the policy engine. The model can raise a tier, never lower one.
- Every table has RLS. A new migration must enable RLS, add a policy, and leave
  `anon` with no grants; `tests/db/rls.test.ts` fails otherwise.
- `audit_log` and `agent_steps` are append-only. `events` allows status changes only.
- Nothing under `policy/` or `prompts/` is writable by any agent tool.
- Real integrations (Twilio, Gmail, Calendar) are out of scope until Phase 5. Use the mock adapters.
- The model is reached only through `LlmPort`. Tests script it with `MockLlm`; never call the API in a test.
- Messages to a contact leave only through `deliver()`. Tools reference people by `contact_id`.
- Seed and test data are fictional: 555-01xx numbers and example.com addresses only.

## Working agreement

- Phases are in `docs/decisions.md`. Stop and report after each one; do not start the next without a go.
- Learning mode: the owner implements the policy engine, the emergency path, and
  the SMS approval parser and flow. For those, write interfaces, types, failing
  tests and a design note only. Review their code; do not rewrite it unless asked.
- After each phase write `docs/walkthrough-phase-N.md`.
