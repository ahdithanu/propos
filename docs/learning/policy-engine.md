# Policy engine — design note

**Yours to implement:** `src/harness/policy/engine.ts`
**Types (done):** `src/harness/policy/types.ts`
**Tests:** `tests/learning/policy-engine.test.ts` — run with `npm run test:learning`

Two functions:

- `evaluatePolicy(input) -> { tier, reasons }` decides the tier for one tool call.
- `applyOverrides(policy, overrides, knownToolNames)` merges dashboard overrides onto the file policy.

## What it must guarantee

1. **The tier is the maximum of every rule that applies.** No rule subtracts. Nothing the model says can lower a tier; its only input is `agentRequestedReview`, which can raise an action to Tier 2.
2. **Code floors beat config.** `tool.baseTier` is declared in the tool's source. Config and overrides can raise it, never go below it.
3. **Tier 3 is not configurable.** A tool in a hard-deny category, an unknown recipient, or another party's contact details in the message is Tier 3 whatever the policy file or any override says.
4. **It fails closed.** Malformed input (bad tier, unknown kind, NaN amount, missing fields, a config value that is not 0, 1 or 2) returns Tier 3 with `invalid_input`. It never throws and never returns a low tier because it could not understand the question.
5. **It is pure.** Same input, same output, input untouched. No clock, no database, no randomness. This is what makes the tier on an old run reproducible from its stored inputs.
6. **Reasons are complete.** Every rule that applied is listed, not only the winner, because the owner reads them and the audit log stores them.

The rules, each with the tier it demands:

| Rule | Applies when | Tier |
|---|---|---|
| `tool_floor` | `tool.baseTier > 0` | baseTier |
| `config_floor` | `policy.tiers.tools[name]` is set; or, for `action` tools only, the default tier | configured |
| `hard_deny_category` | tool has a category in `HARD_DENY_CATEGORIES` | 3 |
| `unknown_recipient` | `recipient.known === false` | 3 |
| `other_party_pii` | `containsOtherPartyPii` | 3 |
| `vendor_no_prior_job` | recipient is a vendor and `vendorHasPriorJob` is not exactly `true` | 2 |
| `amount_over_auto_approve` | `amountCents > spend.auto_approve_max_cents` | 2 |
| `sensitive_content` | `sensitive` | 2 |
| `free_text` | `templateId === null` (not `undefined`) | 2 |
| `agent_requested_review` | flag set, `action` tools only | 2 |

`applyOverrides` accepts only the paths in `OVERRIDABLE_PATHS` plus `tiers.tools.<known tool>`, rejects anything that would not pass `policySchema`, applies valid overrides in order, and returns a new policy.

## How it can fail

- **A rule that lowers.** Any `if owner then tier = 0` shortcut breaks guarantee 1. The monotonicity test exists for this.
- **Config read as truthy/falsy.** `tools[name] || default` treats a configured `0` as "not set" and silently raises it; `??` on a prototype key (`tools["constructor"]`) reads a function. Use an own-property check.
- **Fail open on the unexpected.** `amountCents > max` is `false` for `NaN`, so a naive comparison waves a NaN amount through. Same for a string tier compared with `<`.
- **Missing means safe.** `vendorHasPriorJob === false` skips the rule when the fact is `undefined`. Unknown must count as risky.
- **Overrides as a side door.** Setting `tiers` or `tiers.tools` wholesale, a path through `__proto__`, or a tool name that does not exist. Also mutating the cached file policy, which would make an override permanent for the process.
- **Reasons that disagree with the tier.** Returning the right tier with an incomplete reason list hides why something was blocked.

## What the tests prove

- Each rule in isolation, with exact reasons, and the negative of each (does not fire when the condition is absent).
- Over about 20,000 generated inputs: tier is never below the code floor, tier equals the highest reason, hard-deny conditions are always 3, adding any single risk never lowers the tier, and evaluation is pure on frozen input.
- Fifteen malformed inputs each give Tier 3 without throwing.
- Twenty-two hostile or invalid overrides are each rejected and leave the policy unchanged; valid ones apply; the result always passes the schema; overrides cannot get under a code floor or around a hard deny.

## What they do not prove

- That the **facts** are right. The engine trusts `sensitive`, `containsOtherPartyPii` and `recipient`; those come from keyword and pattern checks in `src/tools/shared.ts` and `src/harness/redact.ts`, which are heuristics.
- That the rule table is the right policy for a real landlord. It encodes the design's examples.
- Anything about `isEventContact` and `isOwner`: they are provided but no rule uses them yet. If you add a rule that uses them, it may only raise.
