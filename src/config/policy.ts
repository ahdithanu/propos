import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { sha256, stableStringify } from "./hash";

const positiveInt = z.number().int().positive();

/** Tiers a policy file may assign. Tier 3 is hardcoded in code, never configured. */
const configurableTier = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const policySchema = z.strictObject({
  version: positiveInt,
  models: z.strictObject({
    agent: z.string().min(1),
    classifier: z.string().min(1),
  }),
  caps: z.strictObject({
    max_steps: positiveInt,
    max_tokens: positiveInt,
    max_wall_ms: positiveInt,
    max_consecutive_tool_failures: positiveInt,
  }),
  tiers: z.strictObject({
    default_tool_tier: configurableTier,
    tools: z.record(z.string(), configurableTier),
  }),
  spend: z.strictObject({
    auto_approve_max_cents: z.number().int().nonnegative(),
    llm_daily_cap_usd: z.number().positive(),
  }),
  undo_window_minutes: positiveInt,
  approvals: z.strictObject({ code_ttl_hours: positiveInt }),
  rate_limits: z.strictObject({
    sms_per_recipient_per_day: positiveInt,
    email_per_recipient_per_day: positiveInt,
    thread_velocity: z.strictObject({
      max_agent_messages: positiveInt,
      window_minutes: positiveInt,
    }),
  }),
  emergency: z.strictObject({
    cooldown_minutes: positiveInt,
    send_attempts: positiveInt,
  }),
  memory: z.strictObject({
    require_review: z.boolean(),
    categories: z.array(z.string().min(1)).min(1),
  }),
});

export type Policy = z.infer<typeof policySchema>;

const templateFileSchema = z.strictObject({
  language: z.string().min(2),
  templates: z.record(
    z.string(),
    z.strictObject({ vars: z.array(z.string()), body: z.string().min(1) }),
  ),
});

export type MessageTemplate = { vars: string[]; body: string };
/** language -> template id -> template */
export type Templates = Record<string, Record<string, MessageTemplate>>;

export type LoadedPolicy = {
  policy: Policy;
  templates: Templates;
  /** sha256 over the policy file and templates, before dashboard overrides. */
  hash: string;
};

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

function readYaml(file: string): unknown {
  return parse(readFileSync(file, "utf8"));
}

function loadTemplates(dir: string): Templates {
  const templates: Templates = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const parsed = templateFileSchema.parse(readYaml(path.join(dir, file)));
    if (templates[parsed.language]) {
      throw new Error(`Duplicate template language "${parsed.language}" in ${file}`);
    }
    for (const [id, template] of Object.entries(parsed.templates)) {
      const used = [...template.body.matchAll(PLACEHOLDER)].map((m) => m[1]!);
      const declared = new Set(template.vars);
      const undeclared = used.filter((v) => !declared.has(v));
      const unused = template.vars.filter((v) => !used.includes(v));
      if (undeclared.length || unused.length) {
        throw new Error(
          `Template ${parsed.language}/${id}: body and vars disagree ` +
            `(undeclared: ${undeclared.join(",") || "none"}; unused: ${unused.join(",") || "none"})`,
        );
      }
    }
    templates[parsed.language] = parsed.templates;
  }

  // Every language must offer the same templates with the same variables, so a
  // template id chosen for one tenant language is always valid for another.
  const languages = Object.keys(templates);
  const [first, ...rest] = languages;
  if (!first) throw new Error(`No template files found in ${dir}`);
  const signature = (lang: string) =>
    stableStringify(
      Object.fromEntries(
        Object.entries(templates[lang]!).map(([id, t]) => [id, [...t.vars].sort()]),
      ),
    );
  for (const lang of rest) {
    if (signature(lang) !== signature(first)) {
      throw new Error(`Templates for "${lang}" do not match "${first}" (ids or vars differ)`);
    }
  }
  return templates;
}

export function loadPolicy(policyDir = path.join(process.cwd(), "policy")): LoadedPolicy {
  const policy = policySchema.parse(readYaml(path.join(policyDir, "policy.yaml")));
  const templates = loadTemplates(path.join(policyDir, "templates"));
  return { policy, templates, hash: sha256(stableStringify({ policy, templates })) };
}
