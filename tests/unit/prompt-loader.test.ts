import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listPromptVersions, loadPrompt } from "@/config/prompts";

function promptsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "propops-prompts-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const prompt = (name: string, version: number, body: string) =>
  `---\nname: ${name}\nversion: ${version}\n---\n${body}\n`;

describe("loadPrompt", () => {
  it("loads the repo's agent prompt", () => {
    const loaded = loadPrompt("agent");
    expect(loaded.version).toBe(1);
    expect(loaded.body.length).toBeGreaterThan(0);
  });

  it("picks the highest version numerically, not alphabetically", () => {
    const dir = promptsDir({
      "triage/v2.md": prompt("triage", 2, "two"),
      "triage/v10.md": prompt("triage", 10, "ten"),
      "triage/notes.md": "ignored",
    });
    expect(listPromptVersions("triage", dir)).toEqual([2, 10]);
    expect(loadPrompt("triage", undefined, dir).body).toBe("ten");
    expect(loadPrompt("triage", 2, dir).body).toBe("two");
  });

  it("hashes the body so an edit without a version bump is visible", () => {
    const a = promptsDir({ "triage/v1.md": prompt("triage", 1, "one") });
    const b = promptsDir({ "triage/v1.md": prompt("triage", 1, "one, edited") });
    expect(loadPrompt("triage", 1, a).hash).not.toBe(loadPrompt("triage", 1, b).hash);
  });

  it("rejects front matter that disagrees with the file path", () => {
    const dir = promptsDir({ "triage/v2.md": prompt("triage", 1, "body") });
    expect(() => loadPrompt("triage", 2, dir)).toThrow(/front matter says/);
  });

  it("rejects a missing prompt, missing front matter, and an empty body", () => {
    const dir = promptsDir({
      "bare/v1.md": "no front matter",
      "empty/v1.md": prompt("empty", 1, ""),
    });
    expect(() => loadPrompt("nope", undefined, dir)).toThrow(/No prompt versions/);
    expect(() => loadPrompt("bare", 1, dir)).toThrow(/no front matter/);
    expect(() => loadPrompt("empty", 1, dir)).toThrow(/empty/);
  });
});
