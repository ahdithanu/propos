/**
 * Model port. The agent loop talks to this, never to a provider SDK, so tests
 * and evals can script the model and production can swap adapters.
 */

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LlmBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface LlmToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export type LlmMessage =
  | { role: "user"; text: string }
  | { role: "user"; toolResults: LlmToolResult[] }
  /** `raw` is the provider's own assistant content, echoed back unchanged on the next turn. */
  | { role: "assistant"; raw: unknown };

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmTurn {
  blocks: LlmBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: LlmUsage;
  raw: unknown;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxOutputTokens: number;
}

export interface LlmPort {
  complete(req: LlmRequest): Promise<LlmTurn>;
}

/** The provider could not be reached or would not serve the request. Triggers degraded mode. */
export class LlmUnavailable extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

/** USD per million tokens. Cache writes are billed at 1.25x input. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
/** Unknown models are costed at the most expensive known rate so the spend cap errs toward stopping. */
const FALLBACK_PRICE = { input: 10, output: 50, cacheRead: 1 };

export function costUsd(model: string, usage: LlmUsage): number {
  const price = PRICES[model] ?? FALLBACK_PRICE;
  return (
    (usage.inputTokens * price.input +
      usage.cacheWriteTokens * price.input * 1.25 +
      usage.cacheReadTokens * price.cacheRead +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
