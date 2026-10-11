import type { ClassMetrics, ComponentSummary } from "./component";
import type { ScenarioResult } from "./run-scenario";

export interface Gate { name: string; passed: boolean; detail: string }

export interface EvalRun {
  date: string;
  model: string;
  promptVersion: number;
  policyHash: string;
  component?: ComponentSummary;
  scenarios: ScenarioResult[];
  gates: Gate[];
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function classTable(title: string, rows: ClassMetrics[]): string[] {
  return [
    `| ${title} | n | precision | recall |`, "|---|---|---|---|",
    ...rows.map((r) => `| ${r.label} | ${r.support} | ${pct(r.precision)} | ${pct(r.recall)} |`), "",
  ];
}

export function suiteStats(results: ScenarioResult[]) {
  const ran = results.filter((r) => !r.error);
  const latencies = ran.flatMap((r) => r.latenciesMs);
  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    errored: results.filter((r) => r.error).length,
    violations: ran.reduce((n, r) => n + r.violations.length, 0),
    meanToolCalls: ran.length ? ran.reduce((n, r) => n + r.toolCalls, 0) / ran.length : 0,
    costUsd: ran.reduce((n, r) => n + r.costUsd, 0),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
  };
}

export function renderReport(run: EvalRun): string {
  const out: string[] = [
    `# PropOps eval report`, "",
    `- Date: ${run.date}`,
    `- Model: ${run.model}${run.model === "mock" ? " (scripted; measures the harness, not a model)" : ""}`,
    `- Prompt: agent v${run.promptVersion}`,
    `- Policy hash: ${run.policyHash.slice(0, 12)}`, "",
    "## Gates", "",
    "| Gate | Result | Detail |", "|---|---|---|",
    ...run.gates.map((g) => `| ${g.name} | ${g.passed ? "pass" : "**FAIL**"} | ${g.detail} |`), "",
  ];

  if (run.component) {
    const c = run.component;
    out.push(
      "## Component: emergency rules", "",
      `- Messages: ${c.total}`,
      `- Rules-only recall, English and Spanish: ${pct(c.rules.recall)} (${c.rules.gatedPositives - c.rules.gatedMisses.length} of ${c.rules.gatedPositives})`,
      `- False positive rate on non-emergencies: ${pct(c.rules.falsePositiveRate)}`,
      `- Emergencies in other languages caught by rules: ${c.rules.ungatedPositives - c.rules.ungatedMisses.length} of ${c.rules.ungatedPositives} (not gated)`, "",
    );
    if (c.rules.gatedMisses.length) out.push("Missed emergencies:", "", ...c.rules.gatedMisses.map((m) => `- ${m}`), "");
    if (c.rules.falsePositives.length) out.push("False alarms:", "", ...c.rules.falsePositives.map((m) => `- ${m}`), "");
    if (c.triage) {
      const t = c.triage;
      out.push(
        "## Component: agent triage", "",
        `- Messages scored: ${t.scored}`,
        `- Category accuracy: ${pct(t.categoryAccuracy)}`,
        `- Urgency accuracy: ${pct(t.urgencyAccuracy)}`,
        `- Emergency recall, rules or model: ${pct(t.unionEmergencyRecall)}`, "",
        ...classTable("Category", t.perCategory), ...classTable("Urgency", t.perUrgency),
      );
      if (t.unionEmergencyMisses.length) out.push("Emergencies missed by both:", "", ...t.unionEmergencyMisses.map((m) => `- ${m}`), "");
      if (t.wrong.length) out.push("Wrong category:", "", ...t.wrong.map((w) => `- ${w.id}: "${w.text}" expected ${w.expected}, got ${w.got}`), "");
    }
  }

  for (const suite of ["trajectory", "adversarial"] as const) {
    const results = run.scenarios.filter((r) => r.suite === suite);
    if (!results.length) continue;
    const s = suiteStats(results);
    out.push(
      `## ${suite[0]!.toUpperCase()}${suite.slice(1)} scenarios`, "",
      `- Passed: ${s.passed} of ${s.total}${s.errored ? ` (${s.errored} did not run)` : ""}`,
      `- Safety violations: ${s.violations}`,
      `- Mean tool calls: ${s.meanToolCalls.toFixed(1)}`,
      `- Model cost: $${s.costUsd.toFixed(4)}`,
      `- Model latency per call: p50 ${s.p50 ?? "n/a"} ms, p95 ${s.p95 ?? "n/a"} ms`, "",
      "| Scenario | Result | Tool calls | Cost | Notes |", "|---|---|---|---|---|",
      ...results.map((r) => {
        const notes = r.error ? `did not run: ${r.error}` : [...r.violations.map((v) => `VIOLATION: ${v}`), ...r.failures].join("; ");
        return `| ${r.id} | ${r.error ? "error" : r.passed ? "pass" : "**fail**"} | ${r.toolCalls} | $${r.costUsd.toFixed(4)} | ${notes.replaceAll("|", "/")} |`;
      }), "",
    );
  }
  return out.join("\n");
}
