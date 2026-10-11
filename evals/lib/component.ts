import type { EmergencyMatch, EmergencyRuleSet } from "@/harness/emergency/types";
import type { ComponentItem } from "./scenario";

export interface Triage {
  /** A request category, or "none" when the agent opened no request. */
  category: string;
  urgency: string | null;
}

export interface ComponentRow {
  item: ComponentItem;
  rulesHit: boolean;
  ruleId?: string;
  /** Absent in rules-only mode. */
  triage?: Triage;
}

export interface ClassMetrics { label: string; support: number; precision: number | null; recall: number | null }

export interface ComponentSummary {
  total: number;
  rules: {
    /** English and Spanish only: the languages the rules claim to cover. */
    gatedPositives: number;
    gatedMisses: string[];
    recall: number | null;
    falsePositives: string[];
    falsePositiveRate: number | null;
    /** Emergencies in languages the rules do not cover. Reported, not gated. */
    ungatedPositives: number;
    ungatedMisses: string[];
  };
  triage?: {
    scored: number;
    categoryAccuracy: number | null;
    urgencyAccuracy: number | null;
    perCategory: ClassMetrics[];
    perUrgency: ClassMetrics[];
    /** Emergencies caught by the rules or labelled emergency by the model. */
    unionEmergencyRecall: number | null;
    unionEmergencyMisses: string[];
    wrong: { id: string; text: string; expected: string; got: string }[];
  };
}

const RULE_LANGUAGES = ["en", "es"];
const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

function perClass(pairs: { expected: string; got: string }[]): ClassMetrics[] {
  const labels = [...new Set(pairs.flatMap((p) => [p.expected, p.got]))].sort();
  return labels.map((label) => {
    const tp = pairs.filter((p) => p.expected === label && p.got === label).length;
    const predicted = pairs.filter((p) => p.got === label).length;
    const support = pairs.filter((p) => p.expected === label).length;
    return { label, support, precision: ratio(tp, predicted), recall: ratio(tp, support) };
  });
}

/** Runs the rule layer over the dataset. Deterministic; needs no model. */
export function runRules(
  items: ComponentItem[],
  detect: (text: string, rules: EmergencyRuleSet) => EmergencyMatch | null,
  rules: EmergencyRuleSet,
): ComponentRow[] {
  return items.map((item) => {
    const match = detect(item.text, rules);
    return { item, rulesHit: match !== null, ruleId: match?.ruleId };
  });
}

export function summarizeComponent(rows: ComponentRow[]): ComponentSummary {
  const gated = rows.filter((r) => RULE_LANGUAGES.includes(r.item.lang));
  const gatedPos = gated.filter((r) => r.item.is_emergency);
  const gatedNeg = gated.filter((r) => !r.item.is_emergency);
  const ungatedPos = rows.filter((r) => !RULE_LANGUAGES.includes(r.item.lang) && r.item.is_emergency);
  const falsePositives = gatedNeg.filter((r) => r.rulesHit);

  const summary: ComponentSummary = {
    total: rows.length,
    rules: {
      gatedPositives: gatedPos.length,
      gatedMisses: gatedPos.filter((r) => !r.rulesHit).map((r) => `${r.item.id}: ${r.item.text}`),
      recall: ratio(gatedPos.filter((r) => r.rulesHit).length, gatedPos.length),
      falsePositives: falsePositives.map((r) => `${r.item.id}: ${r.item.text} (${r.ruleId})`),
      falsePositiveRate: ratio(falsePositives.length, gatedNeg.length),
      ungatedPositives: ungatedPos.length,
      ungatedMisses: ungatedPos.filter((r) => !r.rulesHit).map((r) => `${r.item.id}: ${r.item.text}`),
    },
  };

  const triaged = rows.filter((r) => r.triage);
  if (triaged.length) {
    // "any" marks messages too vague to have one right category; they still count for urgency.
    const cat = triaged.filter((r) => r.item.expected_category !== "any")
      .map((r) => ({ id: r.item.id, text: r.item.text, expected: r.item.expected_category, got: r.triage!.category }));
    const urg = triaged.map((r) => ({ expected: r.item.expected_urgency ?? "none", got: r.triage!.urgency ?? "none" }));
    const emergencies = triaged.filter((r) => r.item.is_emergency);
    const caught = emergencies.filter((r) => r.rulesHit || r.triage!.urgency === "emergency");
    summary.triage = {
      scored: triaged.length,
      categoryAccuracy: ratio(cat.filter((p) => p.expected === p.got).length, cat.length),
      urgencyAccuracy: ratio(urg.filter((p) => p.expected === p.got).length, urg.length),
      perCategory: perClass(cat),
      perUrgency: perClass(urg),
      unionEmergencyRecall: ratio(caught.length, emergencies.length),
      unionEmergencyMisses: emergencies.filter((r) => !caught.includes(r)).map((r) => `${r.item.id}: ${r.item.text}`),
      wrong: cat.filter((p) => p.expected !== p.got),
    };
  }
  return summary;
}
