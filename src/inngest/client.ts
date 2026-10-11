import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "propops" });

export const EVENTS = {
  received: "propops/event.received",
  revise: "propops/action.revise",
  emergencyFallback: "propops/emergency.fallback",
} as const;
