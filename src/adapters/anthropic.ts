import Anthropic from "@anthropic-ai/sdk";
import { LlmUnavailable, type LlmBlock, type LlmPort, type LlmRequest, type LlmTurn } from "@/harness/llm";

const STOP_REASONS: Record<string, LlmTurn["stopReason"]> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

/** Claude via the Anthropic API. Credentials are resolved by the SDK from the environment. */
export class AnthropicLlm implements LlmPort {
  private client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async complete(req: LlmRequest): Promise<LlmTurn> {
    const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m) => {
      if (m.role === "assistant") {
        return { role: "assistant", content: m.raw as Anthropic.Beta.BetaContentBlockParam[] };
      }
      if ("text" in m) return { role: "user", content: m.text };
      return {
        role: "user",
        // All results for one assistant turn go back in a single user message.
        content: m.toolResults.map((r) => ({
          type: "tool_result" as const, tool_use_id: r.toolUseId, content: r.content, is_error: r.isError,
        })),
      };
    });

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        // The system prompt and tool list are identical on every turn and every
        // run, so they are cached; the per-event context follows in messages.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Beta.BetaTool["input_schema"],
        })),
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        // If a safety classifier declines, let the API re-run on its default fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages,
      });
    } catch (err) {
      // Most specific first. The SDK has already retried 429, 5xx and connection errors.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new LlmUnavailable("model credentials rejected", err);
      }
      if (err instanceof Anthropic.RateLimitError) throw new LlmUnavailable("model rate limited", err);
      if (err instanceof Anthropic.APIConnectionError) throw new LlmUnavailable("model unreachable", err);
      if (err instanceof Anthropic.InternalServerError) throw new LlmUnavailable("model provider error", err);
      if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) {
        throw new LlmUnavailable("model provider error", err);
      }
      // 400s and the like are bugs in our request; surface them as failures, not degraded mode.
      throw err;
    }

    const blocks: LlmBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") blocks.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }
    return {
      blocks,
      stopReason: STOP_REASONS[response.stop_reason ?? ""] ?? "other",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      // Echoed back unchanged next turn, thinking blocks included.
      raw: response.content,
    };
  }
}
