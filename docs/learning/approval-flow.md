# SMS approval parser and flow — design note

**Yours to implement:**
- `src/harness/approvals/parser.ts` — `parseOwnerSms(text) -> OwnerCommand`
- `src/harness/approvals/flow.ts` — `handleOwnerSms(deps, input) -> OwnerSmsResult`

**Done:** types (`approvals/types.ts`), the outbox that creates actions and codes and executes them (`src/harness/outbox.ts`), and the store's compare-and-set `transitionAction`.
**Tests:** `tests/learning/approval-parser.test.ts`, `tests/learning/approval-flow.test.ts`

Do the parser first; the flow tests call it.

## What it must guarantee

**Parser** (pure, no database)

1. **An approval is the whole message or it is not an approval.** `Y-4821` approves. `Y-4821 but cap it at $300` does not; it is a revision. Anything ambiguous is not an approval.
2. **Exactly four digits.** `Y-482` and `Y-48211` match nothing. In particular `Y-48211` must not approve 4821.
3. **Tolerant of how phones mangle text:** case, spaces, no dash, en and em dashes, full-width characters, zero-width characters, a trailing `.` or `!`. Also `YES`/`NO`/`UNDO` as words.
4. **`PAUSE`, `RESUME`, `STATUS` only as the whole message.** "pause the sprinklers" is not a command.
5. **A revision is free text that mentions a plausible code.** A 4-digit number that is not money (`$4821`), not a decimal, and not part of a phone number or a longer number. The parser returns candidates; it cannot know which are open.
6. **Total and fast.** Never throws, any input.

**Flow**

7. **Only the verified owner.** Sender equals the owner's number exactly, and the provider signature is valid. Otherwise return `not_owner` having changed nothing and replied to no one.
8. **Approval executes the stored args.** It calls `deps.execute(actionId)`. It never re-asks a model and never rebuilds the action from the SMS text.
9. **Exactly once.** A double tap or two simultaneous webhooks execute one time. Every state change goes through `transitionAction` and you act only if it returned the row.
10. **Expiry is checked at decision time**, against `deps.now()`, not left to a cleanup job.
11. **Each letter does one thing.** `Y`/`N` act on `pending_approval`. `U` acts on `held`. `Y` on a held action or `U` on a pending one is `wrong_state` and changes nothing.
12. **A revision retires the original.** Status becomes `revising`, the code stops being open, an `edit` approval row is written, and the instruction is queued for the agent. The original can no longer be approved as it was.
13. **Every decision leaves a record:** an `approvals` row and an audit entry with `actor: "owner"`.
14. **The owner always gets an answer** to a command, including "no such code", "expired", "approved but paused" and "approved but sending failed". A failed reply must not undo or block the decision.

## How it can fail

- **Greedy matching.** A regex without anchors finds `Y-4821` inside `don't Y-4821` or the first four digits of `Y-48211`.
- **Approve on prefix.** Treating `Y-4821 ...anything` as approve-and-ignore-the-rest sends a message the owner was trying to change.
- **Loose sender matching.** Stripping non-digits or comparing the last ten digits lets `+2 408 555 0100` through. Twilio delivers E.164; anything else is not the owner.
- **Check then act.** `if (action.status === "pending_approval") { execute }` with an await in between runs twice under a double tap.
- **Trusting the cleanup job.** If expiry is only enforced by a tick, a code is valid for up to one tick longer than promised.
- **Code reuse.** Codes are unique among open actions only. `findOpenActionByCode` handles this; looking up by code across all actions would resurrect an old one.
- **A reply that throws.** If `notifyOwner` failing rolls back or skips the approval row, the owner's decision is lost.
- **Numbers that look like codes.** A year, a price, a street number. The flow must treat a revision whose candidates match no open action as an ordinary message (`not_a_command`), not as an error.
- **`STOP`.** Carriers intercept it as an opt-out before it reaches you. Do not use it as a command word.

## What the tests prove

- Parser: 18 spellings of approve, plus reject and undo; 25 near-misses that must not approve; control words and 10 look-alikes; 9 revision shapes with exact candidates; 11 non-revisions; bad input, 100,000-character input, purity.
- Flow: non-owner numbers, an invalid signature and five near-miss sender strings are all refused with no state change; approve executes the stored body once under double tap and under a race; the right action among two; unknown and expired codes; the last valid minute; paused; execution failure; `Y` on held; a failing reply; reject is final; undo before, after and racing the send; revision retires the code and queues the instruction; pause, resume and status.

## What they do not prove

- **Real concurrency.** The store in these tests is in memory and single-threaded, so the race tests exercise interleaving at `await` points only. The Postgres store in Phase 1b has to make `transitionAction` a single `UPDATE ... WHERE status = ANY(...) RETURNING`, and that needs its own test.
- **Sender authenticity.** `signatureValid` is an input here. Verifying the Twilio signature is Phase 5, and caller ID can be spoofed at the carrier level regardless; the 4-digit code is the second factor, and it is short.
- **Brute force.** Nothing limits wrong guesses. It only matters if an attacker can already send as the owner's number.
- **Two open codes in one message** ("4821 and 5932 both too expensive"). Undefined; the tests do not cover it. Decide and add a test.
- **What the agent does with a revision.** `enqueueRevision` is a recorder in these tests. The redraft loop is Phase 1b.
