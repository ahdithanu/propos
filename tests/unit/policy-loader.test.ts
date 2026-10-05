import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "@/config/policy";

const REAL = path.join(process.cwd(), "policy");

/** Copies the real policy dir to a temp dir and lets the test edit files in it. */
function policyCopy(edit: (dir: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), "propops-policy-"));
  cpSync(REAL, dir, { recursive: true });
  edit(dir);
  return dir;
}

function replaceInFile(file: string, from: string | RegExp, to: string) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(from, to);
  if (after === before) throw new Error(`Test setup: nothing replaced in ${file}`);
  writeFileSync(file, after);
}

describe("loadPolicy", () => {
  it("loads the repo policy with every tool defaulting to owner approval", () => {
    const { policy, templates, hash } = loadPolicy();
    expect(policy.tiers.default_tool_tier).toBe(2);
    expect(policy.caps.max_steps).toBe(12);
    expect(policy.memory.require_review).toBe(true);
    expect(Object.keys(templates).sort()).toEqual(["en", "es"]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same hash for the same content and a new hash when a value changes", () => {
    const same = policyCopy(() => {});
    const changed = policyCopy((dir) =>
      replaceInFile(path.join(dir, "policy.yaml"), "max_steps: 12", "max_steps: 13"),
    );
    expect(loadPolicy(same).hash).toBe(loadPolicy().hash);
    expect(loadPolicy(changed).hash).not.toBe(loadPolicy().hash);
  });

  it("changes the hash when a template body changes", () => {
    const changed = policyCopy((dir) =>
      replaceInFile(path.join(dir, "templates/en.yaml"), "follow up soon", "be in touch"),
    );
    expect(loadPolicy(changed).hash).not.toBe(loadPolicy().hash);
  });

  it("rejects unknown keys instead of ignoring a typo", () => {
    const dir = policyCopy((d) =>
      replaceInFile(path.join(d, "policy.yaml"), "undo_window_minutes", "undo_window_minuts"),
    );
    expect(() => loadPolicy(dir)).toThrow();
  });

  it("rejects a config file that tries to set a tool to Tier 3", () => {
    const dir = policyCopy((d) =>
      replaceInFile(path.join(d, "policy.yaml"), "send_ack: 0", "send_ack: 3"),
    );
    expect(() => loadPolicy(dir)).toThrow();
  });

  it("rejects a template whose body uses an undeclared variable", () => {
    const dir = policyCopy((d) =>
      replaceInFile(path.join(d, "templates/en.yaml"), "Hi {{first_name}}, we got", "Hi {{name}}, we got"),
    );
    expect(() => loadPolicy(dir)).toThrow(/body and vars disagree/);
  });

  it("rejects languages whose template sets differ", () => {
    const dir = policyCopy((d) =>
      replaceInFile(path.join(d, "templates/es.yaml"), /  request_more_info:[\s\S]*$/, ""),
    );
    expect(() => loadPolicy(dir)).toThrow(/do not match/);
  });
});
