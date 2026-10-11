import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** People a scenario can refer to. They map to the fixture contacts; "unknown" is a number not in contacts. */
export const ACTORS = ["tenant", "owner", "plumber", "electrician", "hvac", "unknown"] as const;
export type Actor = (typeof ACTORS)[number];
const actor = z.enum(ACTORS);

const mockBlock = z.union([
  z.strictObject({ say: z.string() }),
  z.strictObject({ call: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
]);

const turn = z.union([
  /** An inbound text, followed by the worker handling whatever it queued. */
  z.strictObject({ sms: z.strictObject({ from: actor, body: z.string(), auto_reply: z.boolean().optional() }) }),
  /**
   * The owner answering by text. `approve_latest`, `reject_latest` and
   * `undo_latest` use the most recent open code; free text may use {{code}}.
   */
  z.strictObject({ owner: z.string().min(1) }),
  z.strictObject({ advance_minutes: z.number().positive() }),
  z.strictObject({ tick: z.literal(true) }),
]);

const range = z.strictObject({ min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() });

export const expectSchema = z.strictObject({
  /** Tools that must be called at least once across the scenario. */
  must_call: z.array(z.string()).default([]),
  must_not_call: z.array(z.string()).default([]),
  /** These tools must appear in this relative order (other calls may come between). */
  call_order: z.array(z.string()).default([]),
  /** Every action created for the tool must have exactly this tier. */
  tiers: z.record(z.string(), z.number().int().min(0).max(3)).default({}),
  /** How many messages each actor actually received. Actors not listed are unconstrained. */
  outbound: z.partialRecord(actor, range).default({}),
  /** Strings that must not appear in any message sent to anyone but the owner. */
  outbound_must_not_contain: z.array(z.string()).default([]),
  /** The most recently created maintenance request. */
  final_request: z
    .strictObject({
      status_in: z.array(z.string()).optional(),
      urgency_in: z.array(z.string()).optional(),
      category_in: z.array(z.string()).optional(),
    })
    .optional(),
  /** No maintenance request may have been created. */
  no_request: z.boolean().default(false),
  max_tool_calls: z.number().int().nonnegative().optional(),
  /** Outcome of every agent run. */
  run_outcome_in: z.array(z.enum(["completed", "escalated", "failed", "capped"])).optional(),
  emergency_hit: z.boolean().optional(),
  /** Action statuses that must (not) be present at the end. */
  action_status_present: z.array(z.string()).default([]),
  action_status_absent: z.array(z.string()).default([]),
  /** How many events loop detection suppressed. */
  suppressed: range.optional(),
  /** The owner must have been sent a message containing each of these (case-insensitive). */
  owner_told: z.array(z.string()).default([]),
});

export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  suite: z.enum(["trajectory", "adversarial"]),
  description: z.string().min(10),
  tags: z.array(z.string()).default([]),
  setup: z
    .strictObject({
      paused: z.boolean().optional(),
      overrides: z.array(z.strictObject({ path: z.string(), value: z.unknown() })).optional(),
      /** An open request to start with, id "r-open". */
      open_request: z.strictObject({ title: z.string(), category: z.string(), urgency: z.string(), status: z.string() }).optional(),
    })
    .default({}),
  turns: z.array(turn).min(1),
  /**
   * A scripted model, one entry per model turn across the whole scenario. For
   * adversarial scenarios this is the worst case: a model that does exactly
   * what the attacker asks. Used with `--model mock`; ignored for live models.
   */
  mock_model: z.array(z.array(mockBlock)).optional(),
  expect: expectSchema.default(() => expectSchema.parse({})),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Expect = z.infer<typeof expectSchema>;

export function loadScenarios(dir = path.join(process.cwd(), "evals/scenarios")): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const suite of ["trajectory", "adversarial"]) {
    const suiteDir = path.join(dir, suite);
    for (const file of readdirSync(suiteDir).filter((f) => f.endsWith(".yaml")).sort()) {
      const docs = parse(readFileSync(path.join(suiteDir, file), "utf8")) as unknown;
      for (const doc of Array.isArray(docs) ? docs : [docs]) {
        const parsed = scenarioSchema.safeParse(doc);
        if (!parsed.success) {
          const id = (doc as { id?: string })?.id ?? "?";
          throw new Error(`${suite}/${file} (${id}): ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        }
        if (parsed.data.suite !== suite) throw new Error(`${file}: scenario ${parsed.data.id} is in the wrong folder`);
        scenarios.push(parsed.data);
      }
    }
  }
  const ids = scenarios.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`Duplicate scenario id: ${dup}`);
  return scenarios;
}

export const componentItemSchema = z.strictObject({
  id: z.string(),
  channel: z.enum(["sms", "email"]),
  lang: z.string(),
  text: z.string(),
  /** A request category, or "none" when no maintenance request should be opened. */
  expected_category: z.string(),
  /** Null when no request is expected. */
  expected_urgency: z.enum(["emergency", "urgent", "routine", "cosmetic"]).nullable(),
  is_emergency: z.boolean(),
  tags: z.array(z.string()),
});
export type ComponentItem = z.infer<typeof componentItemSchema>;

export function loadComponentItems(file = path.join(process.cwd(), "evals/datasets/component.jsonl")): ComponentItem[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line, i) => {
    const parsed = componentItemSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`component.jsonl line ${i + 1}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  });
}
