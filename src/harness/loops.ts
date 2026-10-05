import { createHash } from "node:crypto";
import type { Policy } from "@/config/policy";
import type { Message } from "./types";

/** Headers are matched case-insensitively. SMS has none; pass body only. */
export interface AutoReplyInput {
  headers?: Record<string, string>;
  from?: string;
  body: string;
}

const OOO_PHRASES = [
  /\bout of (the )?office\b/i,
  /\bauto(matic|mated)?[- ]?(reply|response|responder)\b/i,
  /\bi am (currently )?(away|on vacation|on leave|unavailable)\b/i,
  /\bi('m| am) driving\b/i, // phone "do not disturb while driving" replies
  /\bthis (mailbox|inbox|number) is not monitored\b/i,
  /\bdo not reply to this (message|email)\b/i,
  /\bfuera de (la )?oficina\b/i,
  /\brespuesta autom[aá]tica\b/i,
  /\bestoy de vacaciones\b/i,
];

const NO_REPLY_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce[s]?)\b/i;

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key]?.trim().toLowerCase() : undefined;
}

export function isNoReplySender(from: string | undefined): boolean {
  if (!from) return false;
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return NO_REPLY_SENDER.test(address.trim());
}

/** True when the message was written by a machine, so replying could start a loop. */
export function isAutoReply(input: AutoReplyInput): boolean {
  const autoSubmitted = header(input.headers, "auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (header(input.headers, "x-autoreply") || header(input.headers, "x-autorespond")) return true;
  const precedence = header(input.headers, "precedence");
  if (precedence && ["bulk", "auto_reply", "junk", "list"].includes(precedence)) return true;
  if (isNoReplySender(input.from)) return true;
  return OOO_PHRASES.some((p) => p.test(input.body));
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex");
}

export type LoopVerdict =
  | { suppress: false }
  | { suppress: true; reason: "auto_reply" | "repeated_body" | "thread_velocity" };

/** How many identical inbound bodies in the window count as a loop. */
const REPEATED_BODY_LIMIT = 3;

/**
 * Decides whether an inbound message should be suppressed instead of handed to
 * the agent. `thread` is the thread's history before this message.
 */
export function checkLoop(
  inbound: { body: string; isAutoReply: boolean },
  thread: Message[],
  limits: Policy["rate_limits"]["thread_velocity"],
  now: Date,
): LoopVerdict {
  if (inbound.isAutoReply) return { suppress: true, reason: "auto_reply" };

  const windowStart = new Date(now.getTime() - limits.window_minutes * 60_000);
  const recent = thread.filter((m) => m.createdAt >= windowStart);

  const hash = bodyHash(inbound.body);
  const sameBody = recent.filter((m) => m.direction === "inbound" && bodyHash(m.body) === hash).length;
  if (sameBody + 1 >= REPEATED_BODY_LIMIT) return { suppress: true, reason: "repeated_body" };

  // Count our messages since the last inbound that looked human. A person who
  // keeps writing new things resets the count; a machine does not.
  const lastHuman = recent.findLast((m) => m.direction === "inbound" && !m.isAutoReply);
  const ours = recent.filter(
    (m) => m.direction === "outbound" && (!lastHuman || m.createdAt > lastHuman.createdAt),
  ).length;
  if (ours >= limits.max_agent_messages) return { suppress: true, reason: "thread_velocity" };

  return { suppress: false };
}
