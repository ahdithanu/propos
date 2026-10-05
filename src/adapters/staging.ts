import type { Owner } from "@/harness/types";
import type { Ports } from "@/harness/ports";

export type Mode = "live" | "staging" | "test";

/** Describes a real recipient address for the staging banner, e.g. "Tenant: Maria". */
export type DescribeRecipient = (address: string) => Promise<string>;

/**
 * Staging mode: every outbound message goes to the owner instead of the real
 * recipient, with a banner saying who it would have gone to. This wraps the
 * adapters themselves, so no caller upstream can bypass it.
 */
export function withStagingRedirect(inner: Ports, owner: Owner, describe: DescribeRecipient): Ports {
  const banner = async (to: string) => `[STAGING → would send to ${await describe(to)}]`;
  return {
    sms: {
      async send(msg) {
        return inner.sms.send({ ...msg, to: owner.phone, body: `${await banner(msg.to)} ${msg.body}` });
      },
    },
    email: {
      async send(msg) {
        return inner.email.send({
          ...msg,
          to: owner.email,
          subject: `[STAGING] ${msg.subject}`,
          body: `${await banner(msg.to)}\n\n${msg.body}`,
        });
      },
    },
    // Calendar writes land on the owner's own calendar and reach nobody else.
    calendar: inner.calendar,
  };
}

/** The only way the harness should obtain ports: mode decides the wrapping. */
export function portsForMode(mode: Mode, inner: Ports, owner: Owner, describe: DescribeRecipient): Ports {
  return mode === "staging" ? withStagingRedirect(inner, owner, describe) : inner;
}

export function parseMode(value: string | undefined): Mode {
  if (value === "live" || value === "staging" || value === "test") return value;
  // Fail safe: an unset or misspelled mode must never mean "send to real people".
  return "staging";
}
