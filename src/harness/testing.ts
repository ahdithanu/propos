import { createMockPorts } from "@/adapters/mocks";
import { loadPolicy, type LoadedPolicy } from "@/config/policy";
import { MemoryStore } from "./store-memory";
import type { Contact, Owner } from "./types";

/** Fixture world mirroring supabase/seed.sql, for unit tests and evals. All fictional. */
export const OWNER: Owner = { contactId: "c-owner", phone: "+14085550100", email: "owner@example.com" };

export const CONTACTS = {
  owner: { id: "c-owner", kind: "owner", displayName: "Sam Owner", firstName: "Sam", phone: "+14085550100", email: "owner@example.com", preferredChannel: "sms", preferredLanguage: "en", isAllowlisted: true },
  tenant: { id: "c-tenant", kind: "tenant", displayName: "Maria Alvarez", firstName: "Maria", phone: "+14085550111", email: "maria.alvarez@example.com", preferredChannel: "sms", preferredLanguage: "es", isAllowlisted: true },
  plumber: { id: "c-plumber", kind: "vendor", displayName: "Bayline Plumbing", firstName: "Dev", phone: "+14085550121", email: "dispatch@bayline.example.com", preferredChannel: "sms", preferredLanguage: "en", isAllowlisted: true },
  electrician: { id: "c-electrician", kind: "vendor", displayName: "Okafor Electric", firstName: "Chidi", phone: "+14085550122", email: "chidi@okafor.example.com", preferredChannel: "sms", preferredLanguage: "en", isAllowlisted: true },
  hvac: { id: "c-hvac", kind: "vendor", displayName: "Valley Heating & Repair", firstName: "Linh", phone: "+14085550123", email: "linh@valleyhr.example.com", preferredChannel: "email", preferredLanguage: "en", isAllowlisted: true },
} as const satisfies Record<string, Contact>;

export const PROPERTY_ID = "p-maple";
export const UNKNOWN_PHONE = "+14085550199";

export function createTestStore(): MemoryStore {
  return new MemoryStore({
    owner: OWNER,
    contacts: Object.values(CONTACTS),
    tenants: [{ id: "t-maria", contactId: "c-tenant", propertyId: PROPERTY_ID, status: "active" }],
    leases: [{ id: "l-1", propertyId: PROPERTY_ID, startDate: "2025-11-01", endDate: "2026-10-31", monthlyRentCents: 320000, dueDay: 1, graceDays: 5, status: "active" }],
    vendors: [
      { id: "v-plumber", contactId: "c-plumber", trades: ["plumbing"], preapproved: true, autoSpendLimitCents: 25000, rating: 5 },
      { id: "v-electrician", contactId: "c-electrician", trades: ["electrical"], preapproved: true, autoSpendLimitCents: 0, rating: 4 },
      { id: "v-hvac", contactId: "c-hvac", trades: ["hvac", "general"], preapproved: false, autoSpendLimitCents: 0, rating: 4 },
    ],
    requests: [
      { id: "r-faucet", propertyId: PROPERTY_ID, tenantId: "t-maria", title: "Kitchen faucet dripping", category: "plumbing", urgency: "routine", status: "closed", missingInfo: [], vendorId: "v-plumber", quoteCents: 18500, createdAt: new Date("2025-12-08T17:20:00Z"), closedAt: new Date("2025-12-12T01:00:00Z") },
    ],
  });
}

let cachedPolicy: LoadedPolicy | undefined;
export function testPolicy(): LoadedPolicy {
  cachedPolicy ??= loadPolicy();
  return structuredClone(cachedPolicy);
}

export const NOW = new Date("2026-10-05T18:00:00Z");

export function createTestWorld() {
  return { store: createTestStore(), ports: createMockPorts(), loaded: testPolicy(), now: NOW };
}
