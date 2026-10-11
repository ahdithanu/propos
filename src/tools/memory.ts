import { z } from "zod";
import { defineTool } from "@/harness/registry";
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, scopeProperty } from "./shared";

export const recallMemory = defineTool({
  name: "recall_memory",
  description: "Notes the owner has approved about the current tenant and property.",
  kind: "read",
  baseTier: 0,
  input: z.strictObject({}),
  output: z.array(z.object({ scope: z.string(), category: z.string(), fact: z.string() })),
  timeoutMs: READ_TIMEOUT_MS,
  async execute(_args, ctx) {
    const { propertyId, tenantId } = await scopeProperty(ctx);
    const facts = [
      ...(tenantId ? await ctx.store.listMemoryFacts("tenant", tenantId, "active") : []),
      ...(await ctx.store.listMemoryFacts("property", propertyId, "active")),
    ];
    return facts.map((f) => ({ scope: f.scope, category: f.category, fact: f.fact }));
  },
});

export const proposeMemoryFact = defineTool({
  name: "propose_memory_fact",
  description:
    "Suggest a short, durable note about the current tenant or property (a contact preference, an access note). " +
    "It is saved for the owner to review and is not used until they approve it.",
  kind: "draft",
  baseTier: 0,
  input: z.strictObject({
    scope: z.enum(["tenant", "property"]),
    category: z.string().min(1).max(40),
    fact: z.string().min(3).max(300),
  }),
  output: z.object({ status: z.enum(["proposed", "active"]), note: z.string() }),
  timeoutMs: WRITE_TIMEOUT_MS,
  maxCallsPerRun: 3,
  async execute(args, ctx) {
    if (!ctx.policy.memory.categories.includes(args.category)) {
      throw new Error(`Category must be one of: ${ctx.policy.memory.categories.join(", ")}`);
    }
    const { propertyId, tenantId } = await scopeProperty(ctx);
    const subjectId = args.scope === "tenant" ? tenantId : propertyId;
    if (!subjectId) throw new Error("No tenant in scope.");
    // The text comes from a model reading untrusted messages. The review gate is the defence.
    const status = ctx.policy.memory.require_review ? "proposed" : "active";
    await ctx.store.insertMemoryFact({
      scope: args.scope, subjectId, category: args.category, fact: args.fact,
      sourceRunId: ctx.runId, status, ownerEdited: false, createdAt: ctx.now(),
    });
    return {
      status,
      note: status === "proposed" ? "Saved for the owner to review. It is not in effect yet." : "Saved.",
    };
  },
});
