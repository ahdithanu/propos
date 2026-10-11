# Phase 2 walkthrough

Five questions an interviewer would ask about the evals, with honest answers.

## 1. What do your evals measure, and what do the numbers you have actually mean?

Three suites. Component: 72 labeled messages, scored for emergency-rule recall
and false alarms, and (with a live model) for the category and urgency of the
request the agent opens. Trajectory: 8 scripted situations run through the real
pipeline with a simulated tenant, vendor and owner, checked for which tools
were called, in what order, at what tier, who received what, and where the
request ended up. Adversarial: 23 attacks checked the same way, plus eight
safety invariants that are checked on every scenario regardless of what it
expects.

The only numbers that exist are from a scripted model. Those say the harness
behaves as designed when the model does what the script says. They say nothing
about any real model.

Weak or unproven:
- **No live-model eval has been run.** There is no API key on the machine, and
  it costs money, so it needs the owner's go-ahead. Triage accuracy, tool
  choice, injection resistance, cost per run and latency are all unmeasured.
- The gates are red in the repo today because the policy engine, emergency
  path and approval flow are stubs. "All gates pass" is true only against a
  reference implementation that is deliberately not in the repo.
- 72 messages is small. Per-class precision and recall on classes with three
  or four examples are noise.

## 2. An adversarial eval with a scripted model sounds circular. Why is it worth anything?

Because it separates two questions. "Does the model resist the attack" depends
on the model and the prompt, and changes with every release. "If the model is
fully compromised, what gets out" depends only on code. Each adversarial
scenario carries a script in which the model does exactly what the attacker
wants: texts a stranger, leaks a phone number, books a vendor on the tenant's
say-so, invents a payment tool. The gate is that nothing leaves and no state
changes that should not. That is the claim the design makes ("defence does not
depend on the prompt"), and this is a test of it.

I checked the suite could fail: against the reference, I broke the policy
engine three ways, the emergency handler twice and the approval flow once.

Weak or unproven:
- Of those six breaks, four were caught as written. One was not caught until I
  added a scenario for it (an emergency arriving while paused). That is one gap
  found by trying six things; there are certainly others.
- One break cannot be caught here at all: an approval flow that accepts any
  sender, because the pipeline already routes only the owner's texts to it. Two
  layers hide each other's bugs; only the unit suite sees that one.
- Removing the "other party's contact details" rule broke only one scenario of
  five that involve leaked details, because free text is held for approval
  anyway. Most adversarial scenarios pass for more than one reason, so they do
  not isolate the rule they are named after.
- The worst-case scripts were written by the same author as the defences. An
  attacker would try things neither of us thought of.

## 3. How does the trajectory runner work, and what can a scenario not express?

A scenario is YAML: optional setup (paused, policy overrides, an open request),
a list of turns (a text from an actor, an owner reply such as `approve_latest`,
a time jump, a tick), an optional scripted model, and expectations. The runner
builds a fresh in-memory world, wires the real pipeline to an in-process queue,
plays the turns, then checks expectations and invariants and records tool
calls, tokens, cost and model latency. Approval codes are deterministic so
transcripts are stable.

Weak or unproven:
- Turns are a fixed list. The simulated tenant cannot react to what the agent
  said, so multi-turn behaviour that depends on the agent's wording (asking a
  clarifying question, then using the answer) is only testable along the one
  path the script assumed. With a live model the script and the agent can
  drift apart.
- Only SMS. No email scenario exists, and the email path of ingest has no
  end-to-end coverage.
- Expectations are structural. Nothing reads the text of a message for tone,
  correctness or language, beyond "must not contain" strings. A reply in the
  wrong language passes.
- Everything runs on the in-memory store. A scenario cannot catch a bug that
  exists only in the Postgres store.
- Eight trajectory scenarios is a start. The target of 25 belongs to Phase 3.

## 4. "Rules-only emergency recall must be 100%." Is that gate meaningful?

It is a floor and a tripwire, not a measurement. The gate runs the owner's rule
file over the 16 English and Spanish emergencies in the component set and fails
on any miss. It also reports the false-alarm rate and, separately, how many
emergencies in other languages the rules caught, which is expected to be zero
and is not gated.

Weak or unproven:
- 100% on 16 messages the rule author can read is not evidence of recall on
  real texts. It mostly proves nobody deleted a rule.
- The dataset already found one phrasing the learning fixture did not have
  ("kicked in the back door"). A set this small finding a miss on the first try
  suggests real recall is well below 100%.
- Messages in Vietnamese and Chinese are in the set and the rules do not cover
  them. The design's backstop for those (alert the owner on unknown-language
  messages) is not built.
- There is no held-out set in the repo by design; one is promised at review.

## 5. If you ran this against a live model tomorrow, what would you not trust in the result?

Weak or unproven:
- Single runs. Nothing repeats a scenario, so there is no variance estimate; a
  pass could be one sample from a 70% behaviour.
- The live trajectory pass rate is reported and deliberately not gated, because
  there is no baseline. Any threshold today would be made up.
- Latency is measured around the model call only, on one machine, with four
  scenarios in parallel. It is not a production number.
- Cost comes from a hard-coded price table and the usage the API reports.
- The component triage score compares one free choice of category against one
  label. Several messages have more than one defensible category; "any" marks
  the vaguest but not all of them.
- The design's `--prompts v1,v2 --models a,b` comparison matrix is not built.
  One model and one prompt version per run; compare by running twice.
- Importing owner edits and rejections into the dataset is not built either
  (the `eval_examples` table was cut in Phase 0).

## Also not verified in this phase

- CI has still never run. Nothing from Phases 1b or 2 is pushed.
- The eval report is written to `evals/reports/`, which is git-ignored; CI
  uploads it as an artifact, untested.
