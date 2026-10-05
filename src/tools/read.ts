import { z } from "zod";
import { defineTool } from "@/harness/registry";
import { READ_TIMEOUT_MS, requireScope, scopeProperty } from "./shared";

// Read tools return data about the triggering contact's own scope only, and
// never phone numbers, emails or the street address.

export const getTenantProfile = defineTool({
  name: "get_tenant_profile",
  description: "Profile of the tenant who sent the message: first name, language, preferred channel.",
  kind: "read",
  baseTier: 0,
  input: z.strictObject({}),
  output: z.object({
    first_name: z.string().nullable(),
    preferred_language: z.string(),
    preferred_channel: z.enum(["sms", "email"]),
    tenant_status: z.string().nullable(),
  }),
  timeoutMs: READ_TIMEOUT_MS,
  async execute(_args, ctx) {
    const contact = requireScope(ctx);
    const tenant = await ctx.store.getTenantByContact(contact.id);
    return {
      first_name: contact.firstName ?? null,
      preferred_language: contact.preferredLanguage,
      preferred_channel: contact.preferredChannel,
      tenant_status: tenant?.status ?? null,
    };
  },
});

export const getLeaseSummary = defineTool({
  name: "get_lease_summary",
  description: "Dates and rent terms of the active lease for the tenant who sent the message.",
  kind: "read",
  baseTier: 0,
  input: z.strictObject({}),
  output: z
    .object({
      start_date: z.string(), end_date: z.string(), monthly_rent_cents: z.number(),
      due_day: z.number(), grace_days: z.number(),
    })
    .nullable(),
  timeoutMs: READ_TIMEOUT_MS,
  async execute(_args, ctx) {
    const { propertyId } = await scopeProperty(ctx);
    const lease = await ctx.store.getActiveLease(propertyId);
    return lease && {
      start_date: lease.startDate, end_date: lease.endDate, monthly_rent_cents: lease.monthlyRentCents,
      due_day: lease.dueDay, grace_days: lease.graceDays,
    };
  },
});

export const listOpenRequests = defineTool({
  name: "list_open_requests",
  description: "Open maintenance requests for the property of the tenant who sent the message.",
  kind: "read",
  baseTier: 0,
  input: z.strictObject({}),
  output: z.array(
    z.object({
      request_id: z.string(), title: z.string(), category: z.string(), urgency: z.string(),
      status: z.string(), missing_info: z.array(z.string()),
    }),
  ),
  timeoutMs: READ_TIMEOUT_MS,
  async execute(_args, ctx) {
    const { propertyId } = await scopeProperty(ctx);
    return (await ctx.store.listRequests(propertyId, { openOnly: true })).map((r) => ({
      request_id: r.id, title: r.title, category: r.category, urgency: r.urgency,
      status: r.status, missing_info: r.missingInfo,
    }));
  },
});

export const listVendors = defineTool({
  name: "list_vendors",
  description: "Vendors on file, optionally filtered by trade. No contact details are returned.",
  kind: "read",
  baseTier: 0,
  input: z.strictObject({ trade: z.string().min(1).optional() }),
  output: z.array(
    z.object({
      vendor_id: z.string(), contact_id: z.string(), name: z.string(), trades: z.array(z.string()),
      preapproved: z.boolean(), rating: z.number().nullable(), has_prior_job: z.boolean(),
    }),
  ),
  timeoutMs: READ_TIMEOUT_MS,
  async execute(args, ctx) {
    const scope = requireScope(ctx);
    const vendors = await ctx.store.listVendors();
    const visible = vendors
      // A vendor's own thread may see only that vendor, not the competition.
      .filter((v) => scope.kind !== "vendor" || v.contactId === scope.id)
      .filter((v) => !args.trade || v.trades.includes(args.trade));
    return Promise.all(
      visible.map(async (v) => ({
        vendor_id: v.id,
        contact_id: v.contactId,
        name: (await ctx.store.getContact(v.contactId))?.displayName ?? "Unknown",
        trades: v.trades,
        preapproved: v.preapproved,
        rating: v.rating ?? null,
        has_prior_job: await ctx.store.vendorHasPriorJob(v.id),
      })),
    );
  },
});

export const getThreadMessages = defineTool({
  name: "get_thread_messages",
  description: "The most recent messages exchanged with the contact who sent the message.",
  kind: "read",
  baseTier: 0,
  input: z.strictObject({ limit: z.number().int().min(1).max(30).default(10) }),
  output: z.array(
    z.object({ direction: z.enum(["inbound", "outbound"]), body: z.string(), at: z.string(), is_auto_reply: z.boolean() }),
  ),
  timeoutMs: READ_TIMEOUT_MS,
  async execute(args, ctx) {
    const contact = requireScope(ctx);
    const threadId = await ctx.store.getOrCreateThread(contact.preferredChannel, contact.id);
    return (await ctx.store.listThreadMessages(threadId)).slice(-args.limit).map((m) => ({
      direction: m.direction, body: m.body, at: m.createdAt.toISOString(), is_auto_reply: m.isAutoReply,
    }));
  },
});
