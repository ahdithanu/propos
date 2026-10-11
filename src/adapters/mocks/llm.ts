import type { LlmBlock, LlmPort, LlmRequest, LlmTurn } from "@/harness/llm";

export type ScriptedTurn =
  | LlmBlock[]
  | { blocks: LlmBlock[]; stopReason?: LlmTurn["stopReason"]; inputTokens?: number; outputTokens?: number }
  | Error
  /** Decide from the request, e.g. to react to a tool result. */
  | ((req: LlmRequest) => LlmBlock[]);

let ids = 0;
/** Shorthand for a scripted tool call. */
export function call(name: string, input: unknown = {}): LlmBlock {
  return { type: "tool_use", id: `toolu_mock_${++ids}`, name, input };
}
export function say(text: string): LlmBlock {
  return { type: "text", text };
}

/**
 * Plays back a fixed list of turns. When the script runs out it ends the run,
 * unless `repeatLast` is set (used to test caps against a model that never stops).
 */
export class MockLlm implements LlmPort {
  requests: LlmRequest[] = [];
  private turn = 0;

  constructor(private script: ScriptedTurn[], private opts: { repeatLast?: boolean } = {}) {}

  async complete(req: LlmRequest): Promise<LlmTurn> {
    this.requests.push(structuredClone(req));
    const index = this.opts.repeatLast ? Math.min(this.turn, this.script.length - 1) : this.turn;
    this.turn++;
    const next = this.script[index];
    if (next instanceof Error) throw next;
    const spec =
      next === undefined ? { blocks: [say("Done.")] }
      : typeof next === "function" ? { blocks: next(req) }
      : Array.isArray(next) ? { blocks: next }
      : next;
    // Fresh ids each time so a repeated scripted turn does not reuse a tool_use id.
    const blocks = spec.blocks.map((b) => (b.type === "tool_use" ? { ...b, id: `toolu_mock_${++ids}` } : b));
    const stopReason =
      ("stopReason" in spec && spec.stopReason) || (blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    return {
      blocks,
      stopReason,
      usage: {
        inputTokens: ("inputTokens" in spec && spec.inputTokens) || 1000,
        outputTokens: ("outputTokens" in spec && spec.outputTokens) || 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      raw: blocks,
    };
  }

  /** Everything the model was shown, as one string, for "did X reach the model" assertions. */
  seen(): string {
    return JSON.stringify(this.requests);
  }
}
