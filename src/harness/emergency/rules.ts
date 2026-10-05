import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { EmergencyRuleSet } from "./types";

const ruleSetSchema = z.strictObject({
  version: z.number().int().positive(),
  rules: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9_]+$/),
      category: z.enum([
        "gas", "fire", "flood", "electrical", "carbon_monoxide",
        "no_heat", "no_water", "injury", "sewage", "security",
      ]),
      language: z.enum(["en", "es", "any"]),
      pattern: z.string().min(1),
    }),
  ),
});

/** Loads and validates policy/emergency-rules.yaml. Rejects duplicate ids and invalid regexes. */
export function loadEmergencyRules(policyDir = path.join(process.cwd(), "policy")): EmergencyRuleSet {
  const parsed = ruleSetSchema.parse(parse(readFileSync(path.join(policyDir, "emergency-rules.yaml"), "utf8")));
  const seen = new Set<string>();
  for (const rule of parsed.rules) {
    if (seen.has(rule.id)) throw new Error(`Duplicate emergency rule id: ${rule.id}`);
    seen.add(rule.id);
    try {
      new RegExp(rule.pattern, "u");
    } catch (err) {
      throw new Error(`Emergency rule ${rule.id} has an invalid pattern: ${(err as Error).message}`);
    }
  }
  return parsed;
}
