import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { sha256 } from "./hash";

const frontMatterSchema = z.strictObject({
  name: z.string().min(1),
  version: z.number().int().positive(),
});

export type LoadedPrompt = {
  name: string;
  version: number;
  body: string;
  /** sha256 of the body, stamped on runs alongside the version. */
  hash: string;
};

const VERSION_FILE = /^v(\d+)\.md$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function listPromptVersions(
  name: string,
  promptsDir = path.join(process.cwd(), "prompts"),
): number[] {
  const dir = path.join(promptsDir, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => VERSION_FILE.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Loads prompts/<name>/v<version>.md. Without a version, loads the highest one. */
export function loadPrompt(
  name: string,
  version?: number,
  promptsDir = path.join(process.cwd(), "prompts"),
): LoadedPrompt {
  const resolved = version ?? listPromptVersions(name, promptsDir).at(-1);
  if (resolved === undefined) throw new Error(`No prompt versions found for "${name}"`);

  const file = path.join(promptsDir, name, `v${resolved}.md`);
  if (!existsSync(file)) throw new Error(`Prompt not found: ${name} v${resolved}`);

  const match = FRONT_MATTER.exec(readFileSync(file, "utf8"));
  if (!match) throw new Error(`Prompt ${name} v${resolved} has no front matter`);
  const meta = frontMatterSchema.parse(parse(match[1]!));
  if (meta.name !== name || meta.version !== resolved) {
    throw new Error(
      `Prompt ${name} v${resolved}: front matter says ${meta.name} v${meta.version}`,
    );
  }
  const body = match[2]!.trim();
  if (!body) throw new Error(`Prompt ${name} v${resolved} is empty`);
  return { name, version: resolved, body, hash: sha256(body) };
}
