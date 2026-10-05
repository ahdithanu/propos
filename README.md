# PropOps

An agent harness that handles tenant and vendor communication for one owner and
one California rental house. The owner approves anything that matters by text.

Status: Phase 1a. The harness runs on mock adapters and an in-memory store; nothing sends real messages. See `docs/decisions.md`
for the phase plan and `docs/design.md` for the design.

## Run it

Needs Node 22+ and Docker.

```bash
npm install
npm run db:start     # local Supabase on ports 544xx
npm test             # unit tests
npm run test:db      # schema, RLS and seed tests
npm run dev
```

Copy `.env.example` to `.env.local`. No external accounts are needed before Phase 1b.

## Layout

```
app/         Next.js App Router (dashboard arrives in Phase 4)
src/config/  policy and prompt loaders
src/harness/ events, registry, outbox, delivery, loop detection, redaction
src/tools/   the tools the agent can call
src/adapters/ mock SMS, email and calendar; staging redirect
policy/      versioned policy defaults and message templates (EN, ES)
prompts/     versioned prompts, prompts/<name>/v<N>.md
supabase/    migrations and seed
tests/       unit/ and db/
docs/        design, decisions, per-phase walkthroughs
```
