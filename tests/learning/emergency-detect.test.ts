/**
 * LEARNING MODE: emergency detection. Read docs/learning/emergency-path.md first.
 * Implement src/harness/emergency/detect.ts and write policy/emergency-rules.yaml
 * until this file is green.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectEmergency, normalizeForRules } from "@/harness/emergency/detect";
import { loadEmergencyRules } from "@/harness/emergency/rules";
import type { EmergencyCategory, EmergencyRuleSet } from "@/harness/emergency/types";

interface Labeled {
  text: string;
  lang: "en" | "es";
  is_emergency: boolean;
  category?: EmergencyCategory;
  tags: string[];
}

const messages: Labeled[] = readFileSync(path.join(process.cwd(), "tests/fixtures/emergency-messages.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((line) => JSON.parse(line));

const synthetic: EmergencyRuleSet = {
  version: 1,
  rules: [
    { id: "first", category: "gas", language: "any", pattern: "zzz" },
    { id: "second", category: "fire", language: "any", pattern: "zzz+ top" },
    { id: "accent", category: "flood", language: "es", pattern: "inundacion" },
  ],
};

describe("normalizeForRules", () => {
  it.each([
    ["  HELLO   World \n\n ok ", "hello world ok"],
    ["Está Inundándose", "esta inundandose"],
    ["calefacción y baño", "calefaccion y bano"],
    ["smell​ gas‍ now﻿", "smell gas now"],
    ["ＦＩＲＥ １２３", "fire 123"],
    ["", ""],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeForRules(input)).toBe(expected);
  });
});

describe("detectEmergency (mechanics, with a synthetic rule set)", () => {
  it("returns the rule, its category and the matched text", () => {
    expect(detectEmergency("there is ZZZ here", synthetic)).toEqual({ ruleId: "first", category: "gas", matched: "zzz" });
  });

  it("matches against normalized text, so one ASCII rule covers accents and case", () => {
    expect(detectEmergency("¡INUNDACIÓN!", synthetic)?.ruleId).toBe("accent");
  });

  it("returns the first matching rule in file order", () => {
    expect(detectEmergency("zzzz top", synthetic)?.ruleId).toBe("first");
  });

  it("returns null when nothing matches or there are no rules", () => {
    expect(detectEmergency("all quiet", synthetic)).toBeNull();
    expect(detectEmergency("zzz", { version: 1, rules: [] })).toBeNull();
  });

  it("is synchronous: rules only, nothing to await", () => {
    expect(detectEmergency("zzz", synthetic)).not.toBeInstanceOf(Promise);
  });

  it("never throws on bad input", () => {
    for (const bad of [undefined, null, 42, {}, ["zzz"]]) {
      expect(detectEmergency(bad as unknown as string, synthetic)).toBeNull();
    }
  });

  it("does not carry state between calls", () => {
    // A global or sticky regex reused across calls would alternate between hit and miss.
    for (let i = 0; i < 5; i++) expect(detectEmergency("zzz", synthetic)).not.toBeNull();
  });

  it("finds a match late in a long message", () => {
    expect(detectEmergency(`${"filler words here. ".repeat(450)} zzz`, synthetic)).not.toBeNull();
  });
});

describe("the repo's rules (policy/emergency-rules.yaml)", () => {
  const rules = loadEmergencyRules();
  const hit = (m: Labeled) => detectEmergency(m.text, rules);
  const positives = messages.filter((m) => m.is_emergency);

  it("has rules for both languages", () => {
    expect(rules.rules.length).toBeGreaterThan(0);
    for (const lang of ["en", "es"]) {
      expect(rules.rules.some((r) => r.language === lang || r.language === "any"), lang).toBe(true);
    }
  });

  it.each(["en", "es"] as const)("catches every labeled emergency in %s (100% recall)", (lang) => {
    const missed = positives.filter((m) => m.lang === lang && !hit(m)).map((m) => m.text);
    expect(missed).toEqual([]);
  });

  it("assigns the expected category where the label is unambiguous", () => {
    const wrong = positives
      .filter((m) => m.category)
      .map((m) => ({ text: m.text, expected: m.category, got: hit(m)?.category }))
      .filter((r) => r.got !== undefined && r.got !== r.expected);
    expect(wrong).toEqual([]);
  });

  it("stays quiet on messages that are clearly not emergencies", () => {
    const falseAlarms = messages
      .filter((m) => !m.is_emergency && m.tags.includes("clear") && hit(m))
      .map((m) => `${m.text} -> ${hit(m)!.ruleId}`);
    expect(falseAlarms).toEqual([]);
  });

  it("over-triggers on at most half of the ambiguous messages", () => {
    // False alarms are cheap, so this bound is loose. It exists to catch a rule like /gas/.
    const ambiguous = messages.filter((m) => m.tags.includes("ambiguous"));
    const fired = ambiguous.filter(hit).map((m) => m.text);
    expect(fired.length, `fired on: ${fired.join(" | ")}`).toBeLessThanOrEqual(ambiguous.length / 2);
  });

  it("is fast on long and repetitive input", () => {
    const nasty = [
      "a ".repeat(5000), "gas ".repeat(2500), "no ".repeat(3000) + "x", "hay ".repeat(2500),
      "water ".repeat(1600), " ".repeat(10000), "smell".repeat(2000), "!".repeat(10000),
    ];
    for (const text of nasty) {
      const start = performance.now();
      detectEmergency(text, rules);
      expect(performance.now() - start, text.slice(0, 12)).toBeLessThan(250);
    }
  });
});
