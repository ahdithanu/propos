import { z } from "zod";
import { ScopeError, defineTool } from "@/harness/registry";
import { WRITE_TIMEOUT_MS, scopeProperty } from "./shared";

// Record-keeping tools change internal rows only. Nothing leaves the system.

const urgency = z.enum(["emergency", "urgent", "routine", "cosmetic"]);
const status = z.enum([
  "new", "info_needed", "vendor_requested", "quoted", "scheduled", "in_progress", "done", "closed", "cancelled",
]);

export const createMaintenanceRequest = defineTool({
  name: "create_maintenance_request",
  description: "Open a maintenance request for the property of the tenant who sent the message.",
  kind: "draft",
  baseTier: 0,
  input: z.strictObject({
    title: z.string().min(3).max(120),
    category: z.string().min(2).max(40),
    urgency,
    urgency_reason: z.string().min(3).max(300),
    missing_info: z.array(z.string().min(1).max(200)).max(8).default([]),
  }),
  output: z.object({ request_id: z.string(), status }),
  timeoutMs: WRITE_TIMEOUT_MS,
  maxCallsPerRun: 2,
  async execute(args, ctx) {
    const { propertyId, tenantId } = await scopeProperty(ctx);
    const request = await ctx.store.insertRequest({
      propertyId, tenantId, title: args.title, category: args.category, urgency: args.urgency,
      urgencyReason: args.urgency_reason, missingInfo: args.missing_info,
      status: args.missing_info.length ? "info_needed" : "new", createdAt: ctx.now(),
    });
    return { request_id: request.id, status: request.status };
  },
});

export const updateMaintenanceRequest = defineTool({
  name: "update_maintenance_request",
  description: "Update status or details of a maintenance request in the current property.",
  kind: "draft",
  baseTier: 0,
  input: z.strictObject({
    request_id: z.string().min(1),
    status: status.optional(),
    urgency: urgency.optional(),
    missing_info: z.array(z.string().min(1).max(200)).max(8).optional(),
    vendor_id: z.string().min(1).optional(),
    quote_cents: z.number().int().nonnegative().optional(),
  }),
  output: z.object({ request_id: z.string(), status }),
  timeoutMs: WRITE_TIMEOUT_MS,
  async execute(args, ctx) {
    const { propertyId } = await scopeProperty(ctx);
    const existing = await ctx.store.getRequest(args.request_id);
    if (!existing || existing.propertyId !== propertyId) {
      throw new ScopeError("That request does not belong to this property.");
    }
    if (args.vendor_id && !(await ctx.store.getVendor(args.vendor_id))) throw new Error("Unknown vendor.");
    const updated = await ctx.store.updateRequest(
      args.request_id,
      {
        status: args.status, urgency: args.urgency, missingInfo: args.missing_info,
        vendorId: args.vendor_id, quoteCents: args.quote_cents,
        closedAt: args.status === "closed" ? ctx.now() : undefined,
      },
      "agent",
      ctx.now(),
    );
    return { request_id: updated.id, status: updated.status };
  },
});

export const logExpense = defineTool({
  name: "log_expense",
  description: "Record an expense already incurred for a maintenance request. This records money; it does not spend it.",
  kind: "draft",
  baseTier: 0,
  input: z.strictObject({
    request_id: z.string().min(1),
    amount_cents: z.number().int().positive(),
    category: z.string().min(2).max(40),
    incurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  output: z.object({ expense_id: z.string() }),
  timeoutMs: WRITE_TIMEOUT_MS,
  async execute(args, ctx) {
    const { propertyId } = await scopeProperty(ctx);
    const request = await ctx.store.getRequest(args.request_id);
    if (!request || request.propertyId !== propertyId) {
      throw new ScopeError("That request does not belong to this property.");
    }
    const { id } = await ctx.store.insertExpense({
      propertyId, requestId: request.id, vendorId: request.vendorId,
      category: args.category, amountCents: args.amount_cents, incurredOn: args.incurred_on,
    });
    return { expense_id: id };
  },
});

export const requestOwnerReview = defineTool({
  name: "request_owner_review",
  description: "Ask that every later action in this run be approved by the owner. Use when unsure. Cannot be undone.",
  kind: "draft",
  baseTier: 0,
  input: z.strictObject({ reason: z.string().min(3).max(300) }),
  output: z.object({ review_required: z.literal(true) }),
  timeoutMs: WRITE_TIMEOUT_MS,
  async execute(_args, ctx) {
    ctx.requestReview();
    return { review_required: true as const };
  },
});
