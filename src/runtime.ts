import { Pool } from "pg";
import { AnthropicLlm } from "@/adapters/anthropic";
import { createMockPorts } from "@/adapters/mocks";
import { PgStore } from "@/adapters/postgres/store";
import { parseMode, portsForMode } from "@/adapters/staging";
import { loadPolicy } from "@/config/policy";
import { loadPrompt } from "@/config/prompts";
import { createHarness } from "@/harness";
import { handleOwnerSms } from "@/harness/approvals/flow";
import { handleEmergency } from "@/harness/emergency/handler";
import { loadEmergencyRules } from "@/harness/emergency/rules";
import { createPipeline, type Pipeline } from "@/harness/pipeline";
import { evaluatePolicy } from "@/harness/policy/engine";
import { inngestQueue } from "@/inngest/functions";
import { ALL_TOOLS } from "@/tools";

let pipeline: Promise<Pipeline> | undefined;

/**
 * Composition root: the one place real implementations are chosen. Built lazily
 * on first use so `next build` does not need a database or any keys.
 */
export function getPipeline(): Promise<Pipeline> {
  pipeline ??= build().catch((err) => {
    pipeline = undefined;
    throw err;
  });
  return pipeline;
}

async function build(): Promise<Pipeline> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const store = new PgStore(new Pool({ connectionString: url, max: 5 }));
  const owner = await store.getOwner();

  // There are no real SMS, email or calendar adapters until Phase 5, so outbound
  // messages are recorded in the database and go nowhere. "live" is therefore
  // not honoured yet: anything other than "test" is treated as staging.
  const mode = parseMode(process.env.PROPOPS_MODE) === "test" ? "test" : "staging";
  const ports = portsForMode(mode, createMockPorts(), owner, async (address) => {
    const contact = (await store.findContactByPhone(address)) ?? (await store.findContactByEmail(address));
    return contact ? `${contact.kind}: ${contact.firstName ?? contact.displayName}` : "unknown recipient";
  });

  const loaded = loadPolicy();
  const now = () => new Date();
  const harness = createHarness({ store, ports, loaded, evaluate: evaluatePolicy, tools: ALL_TOOLS, now });

  return createPipeline({
    store, ports, harness, loaded, now,
    llm: new AnthropicLlm(),
    prompt: loadPrompt("agent"),
    queue: inngestQueue,
    emergency: { rules: loadEmergencyRules(), handle: handleEmergency },
    handleOwnerSms,
  });
}
