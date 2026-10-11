import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio request validation: base64(HMAC-SHA1(authToken, url + each POST
 * parameter's name and value, sorted by name)). `url` must be the exact public
 * URL Twilio called, including scheme and query string.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioSignature(
  authToken: string, url: string, params: Record<string, string>, signature: string | null,
): boolean {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
