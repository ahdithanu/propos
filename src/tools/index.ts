import type { ToolDef } from "@/harness/registry";
import { alertOwner, scheduleVendorVisit, sendAck, sendFreeTextMessage, sendTemplateMessage } from "./outbound";
import { proposeMemoryFact, recallMemory } from "./memory";
import { getLeaseSummary, getTenantProfile, getThreadMessages, listOpenRequests, listVendors } from "./read";
import { createMaintenanceRequest, logExpense, requestOwnerReview, updateMaintenanceRequest } from "./records";

/** Every tool the agent can call. There is deliberately no tool for payments, signing or deleting. */
export const ALL_TOOLS = [
  getTenantProfile, getLeaseSummary, listOpenRequests, listVendors, getThreadMessages, recallMemory,
  createMaintenanceRequest, updateMaintenanceRequest, logExpense, requestOwnerReview, proposeMemoryFact,
  sendAck, sendTemplateMessage, sendFreeTextMessage, alertOwner, scheduleVendorVisit,
] as unknown as ToolDef[];
