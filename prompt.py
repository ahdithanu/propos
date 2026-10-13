"""The triage prompt and label sets. Shared by the eval and, later, the serving app,
so what is measured is exactly what is served."""

URGENCIES = ("emergency", "urgent", "routine")
DISPATCHES = ("plumber", "electrician", "handyman", "hvac", "locksmith", "pest-control", "none")

SYSTEM_PROMPT = """\
You triage tenant maintenance messages for a landlord. Given the tenant's
message, decide urgency and draft a reply.

Respond with JSON only, exactly this shape:
{"urgency": "emergency|urgent|routine", "draft_reply": "...", "dispatch": "..."}

Urgency rules:
- emergency: immediate safety/property risk (gas smell, flooding, no heat in winter, lockout)
- urgent: degrades habitability soon (appliance failure, pest sighting, leak contained)
- routine: cosmetic/scheduling (paint touch-up, noise question, filter reminder)

draft_reply: a short, professional landlord reply acknowledging the issue and
stating next step. dispatch: who to send — "plumber", "electrician", "handyman",
"hvac", "locksmith", "pest-control", or "none".
"""
