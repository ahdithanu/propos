# Phase 1a walkthrough

Five questions an interviewer would ask about the harness core, with honest answers.

## 1. The model proposes an action. What stops it from just doing it?

The model's only output is a tool name and raw arguments. `ToolRegistry.call`
validates the arguments against the tool's Zod schema, gathers facts about the
call from the store (is the recipient a known contact, is this a vendor with a
prior job, does the text contain someone else's phone number), and hands those
to the policy engine, which returns a tier. The model never supplies a fact or a
tier. Tier 0 runs; Tier 1 is held for an undo window; Tier 2 is stored with its
validated arguments and a 4-digit code and waits; Tier 3 is refused. When an
approval arrives, the outbox executes the stored arguments. It does not ask the
model again. If the policy engine throws or returns something that is not a
tier, the registry treats the call as Tier 3.

Weak or unproven:
- **The policy engine does not exist yet.** It is one of the owner's three
  learning-mode pieces. Every registry and outbox test uses a stand-in that maps
  tool names to tiers. The routing is tested; the deciding is not.
- The facts are heuristics. "Sensitive" is a keyword list. "Contains another
  party's contact details" matches known contacts' phone numbers and emails, so
  a number written as words, or an address, passes.
- Tool arguments that are free text (template variables, a request title) are
  written to the database unfiltered. A later reader of those fields must treat
  them as untrusted.

## 2. The owner texts PAUSE. What is still able to leave the system?

Two checks, both at execution time rather than when the action was queued. The
executor refuses any action tool not marked owner-directed while paused, and
`deliver`, the single function through which a message reaches a contact,
refuses any non-owner recipient while paused. Tests cover a held message whose
undo window expires during a pause, a calendar booking, and that `alert_owner`
still works. Blocked actions become `blocked_paused` and are not sent
automatically on resume.

Weak or unproven:
- The emergency handler is the owner's to write and receives the raw SMS port,
  so it does not pass through `deliver`. Whether it honours the pause depends on
  that implementation; a test in the learning suite requires it.
- "Single function" is a convention. Nothing stops a future tool from calling
  `ctx.ports.sms.send` directly; the tools have the ports in their context
  because the calendar tool needs them.
- There is no pause check between `deliver`'s state read and the provider call.
  A pause that lands in that gap does not stop that one message.
- Nobody can actually send PAUSE yet. The command is parsed by the owner's
  learning-mode flow.

## 3. Twilio retries a webhook, or an auto-responder answers every message. What happens?

`ingestInbound` inserts the event first, keyed on provider message id. A retry
finds the row and returns before anything else runs: no second emergency check,
no second message row, no second enqueue. Then the emergency handler runs, then
loop detection: a message is suppressed if it looks machine-written (headers,
no-reply sender, out-of-office phrasing in English and Spanish), if the same
body has arrived three times inside the window, or if we have sent the
configured number of messages since the last human-looking inbound. Separately,
`deliver` enforces a rolling 24-hour cap per recipient.

Weak or unproven:
- Enqueue happens before the status is set to `queued`. A crash between the two
  leaves a queued event marked `received`; the sweeper that would re-enqueue it
  is Phase 1b, and with it the event would be processed twice unless the queue
  dedupes.
- "Looks human" is a phrase list. An auto-responder with unusual wording and a
  varying body is caught only by the velocity limit, after three of our replies.
- SMS has no headers, so SMS auto-reply detection is phrases only.
- A suppressed event writes an audit entry and nothing else. The owner digest
  the design mentions does not exist.

## 4. What does "runs on mocks" mean here, and how much of this would survive contact with real services?

The harness depends on three ports (SMS, email, calendar) and a `Store`
interface. Tests inject mock adapters that record what was sent and an
in-memory store. Staging mode wraps the ports so every message goes to the
owner with a banner naming the intended recipient; because it wraps the
adapters, callers cannot skip it, and an unset or misspelled mode means staging.

Weak or unproven:
- **Nothing in `src/harness` has run against Postgres.** The schema exists and
  is tested, the harness exists and is tested, and the code joining them is
  Phase 1b. Column names and types have been kept in step by hand.
- The in-memory store is single-threaded. The compare-and-set methods that
  prevent double execution are correct there by construction; the SQL versions
  have to be written as single statements and tested under real concurrency.
- The mocks never time out, rate-limit, reorder or half-succeed. The mock SMS
  dedupes on idempotency key. Whether Twilio does the same for message creation
  has not been checked; if it does not, the real adapter has to provide it.
- Per-run state (call counts, the review flag) lives in memory on the registry.
  On serverless it will not survive between steps of the same run.
- The staging banner calls a lookup function that is not wired to anything yet.

## 5. Three pieces were left for the owner to write. How do you know the tests for them are any good?

Each has typed interfaces, a design note stating guarantees and failure modes,
and a suite that fails today with "Not implemented". Before handing them over
the suites were run against a throwaway reference implementation kept outside
the repo: 252 of 252 passed, so they are satisfiable and do not contradict each
other. The policy suite checks invariants over roughly 20,000 generated inputs
(never below the code floor, monotonic in every risk, pure). The parser suite
is mostly near-misses that must not approve. The emergency suite requires 100%
recall on 56 labeled English and Spanish messages.

Weak or unproven:
- Passing a reference implementation shows the tests can pass, not that they
  reject every wrong implementation. No mutation testing was done.
- The same person wrote the tests, the fixtures and the reference, so shared
  blind spots are invisible to all three.
- The emergency fixture is 56 positives written by an AI imagining how tenants
  text. Recall on it is a floor. A held-out set is planned for the review step.
- The policy rule table is the design's examples turned into code. Nobody has
  checked it against how the owner actually wants decisions made.

## Also not verified in this phase

- Nothing has been committed or pushed; CI has still never run.
- The tool list (D13), the encryption deferral (D2), the table cuts (D3) and
  the pause-holds-emergency-reply reading (D7) were all decided by the agent
  and not explicitly confirmed by the owner.
- No webhook route, no Inngest function and no agent loop exist. `ingestInbound`
  and the registry are called only by tests.
