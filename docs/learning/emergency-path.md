# Emergency path — design note

**Yours to implement:**
- `src/harness/emergency/detect.ts` — `normalizeForRules`, `detectEmergency`
- `policy/emergency-rules.yaml` — the rules themselves
- `src/harness/emergency/handler.ts` — `handleEmergency`

**Done:** types (`emergency/types.ts`), the rule file loader (`emergency/rules.ts`), the `emergency_safety` template in English and Spanish, and the labeled messages in `tests/fixtures/emergency-messages.jsonl`.
**Tests:** `tests/learning/emergency-detect.test.ts`, `tests/learning/emergency-handler.test.ts`

Do `detect.ts` first; the handler tests call it.

## What it must guarantee

**Detection**

1. **Rules only.** No model, no network, synchronous. It runs inside the webhook.
2. **100% recall on the labeled English and Spanish emergencies.** A miss is the failure that matters. False alarms are cheap, so tune toward firing.
3. **Robust to how people text.** Case, accents (or none), full-width characters, zero-width characters, extra whitespace. Rules are written once in lowercase ASCII against normalized text.
4. **Never throws, and stays fast** on any input, including non-strings and 10,000-character messages.

**Handling** (on a hit)

5. **The sender gets the safety template** in their language (English if there is none), sent straight through `deps.sms`. No model, no queue.
6. **The owner is always alerted**, including in every case where the sender is not answered. The two sends are independent: one failing must not stop the other.
7. **Once per event.** A webhook retry or two concurrent deliveries produce one reply and one alert. Use `store.markEmergencyHit`, which is compare-and-set.
8. **It knows when not to text the sender:** an auto-reply (never answer a machine), a number not in contacts (never text a stranger), the same contact within the cooldown, and while paused. In each case the owner alert says what happened.
9. **Twilio failure is handled:** retry in-process up to `sendAttempts` with the same idempotency key, then `enqueueFallback`. Never give up silently.
10. **It never throws.** The webhook still has to enqueue the event.

Decision recorded as D7: **when paused, the reply to the sender is held and the owner is told so.** This follows my reading of "pause on emergency". If you meant the opposite (emergency replies ignore the pause), change the `paused:` test and the `held_paused` outcome before you implement.

## How it can fail

- **A miss.** Phrasing the rules never saw: slang, typos, a third language, a photo with no text, "it smells weird in here". Rules cannot fix this; the owner alert on unknown-language messages and the model later in the pipeline are the backstops.
- **A rule that is too broad.** `/gas/` fires on "gasto" and "gas bill". `/fire/` fires on "fire the gardener". Harmless once, but an owner who gets ten false alarms stops reading them.
- **A regex that hangs.** Nested quantifiers on attacker-controlled text. Keep patterns bounded (`.{0,30}`, not `.*`) and cap the input length.
- **A stateful regex.** A pattern compiled with the `g` or `y` flag and reused keeps `lastIndex` and alternates between hit and miss.
- **Double sending.** Check-then-send without a compare-and-set, or a new idempotency key per retry so the provider cannot dedupe.
- **A loop.** Replying to an auto-responder whose text contains "fire", every time it answers. The auto-reply skip and the cooldown both guard this.
- **One failure taking the other down.** `await sendTenant(); await sendOwner();` with no try/catch means a tenant-side failure leaves the owner uninformed.
- **Forgetting to record the reply.** The cooldown reads the last outbound message with the `emergency_safety` template id. If the handler does not insert that message, the cooldown never triggers.
- **Staging bypass.** Building a Twilio client inside the handler instead of using `deps.sms`.

## What the tests prove

- Normalization on six inputs; detection mechanics on a synthetic rule set (first match wins, no state between calls, null on bad input, finds a match near the end of a long message).
- With your rules: every one of the 56 labeled emergencies is caught, per language; the category is right where the label is unambiguous; none of the 18 clearly-safe messages fire; at most half of the 13 ambiguous ones do; eight adversarial long inputs each finish within 250 ms.
- Handler: correct template and language; owner alert content and length; event marked and reply recorded; the four do-not-text cases; idempotency including a race; retry count, sleeps, idempotency keys and the fallback job; independence of the two sends; no throw when SMS, the queue and the audit log all fail; nothing reaches the tenant's number in staging.

## What they do not prove

- **Recall on messages you have not seen.** 100% on 56 messages you wrote rules against is a floor, not an estimate. After you implement, I will give you a held-out set you have not seen; that number is the honest one.
- Anything about languages other than English and Spanish.
- That the template wording is right, or that the Spanish reads naturally. I wrote both; have a fluent speaker check the Spanish.
- Real Twilio behaviour: delivery receipts, carrier filtering of the word "emergency", or how long three retries take inside a webhook timeout.
