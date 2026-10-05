import type { LoadedPolicy, Policy } from "@/config/policy";
import { deliver } from "./deliver";
import { Outbox } from "./outbox";
import type { PolicyEvaluator } from "./policy/types";
import type { Ports } from "./ports";
import { ToolRegistry, type ToolContext, type ToolDef } from "./registry";
import type { Store } from "./store";
import type { Contact } from "./types";

export interface HarnessDeps {
  store: Store;
  /** Must come from portsForMode() so staging cannot be bypassed. */
  ports: Ports;
  loaded: LoadedPolicy;
  /** Effective policy (file plus overrides). Defaults to the file policy. */
  getPolicy?: () => Policy;
  evaluate: PolicyEvaluator;
  tools: ToolDef[];
  now: () => Date;
  random?: () => number;
}

/** Wires the registry, outbox and delivery together around one store and one set of ports. */
export function createHarness(deps: HarnessDeps) {
  const getPolicy = deps.getPolicy ?? (() => deps.loaded.policy);
  // The outbox looks tools up by name at execution time; the registry is built after it.
  const lookup: { registry?: ToolRegistry } = {};
  const outbox = new Outbox({
    store: deps.store, ports: deps.ports, getPolicy, templates: deps.loaded.templates, now: deps.now,
    getTool: (name) => lookup.registry?.get(name), random: deps.random,
  });
  const registry = new ToolRegistry(deps.tools, deps.evaluate, outbox);
  lookup.registry = registry;

  /** Context for one run, scoped to the contact whose event triggered it. */
  const contextFor = (scope: { contact?: Contact; runId?: string; eventId?: string }): Omit<ToolContext, "requestReview"> => {
    const policy = getPolicy();
    return {
      store: deps.store, ports: deps.ports, policy, templates: deps.loaded.templates, now: deps.now,
      scopeContact: scope.contact, runId: scope.runId, eventId: scope.eventId,
      deliver: (req) => deliver({ store: deps.store, ports: deps.ports, policy, now: deps.now }, req),
    };
  };

  return { registry, outbox, contextFor, getPolicy };
}

export type Harness = ReturnType<typeof createHarness>;
