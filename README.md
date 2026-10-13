# Tenant triage

Classifies a tenant's maintenance message as emergency, urgent or routine, picks
who to send, and drafts a reply. One small open model, deployed on Baseten,
measured for quality, latency and cost.

## Status

Nothing is deployed yet and no eval has been run against a model.

- `truss/config.yaml` follows Baseten's current guide but has not been pushed.
- `data/eval_examples.jsonl` holds three hand-written examples. They show the
  format. They are not a dataset, and they are not real messages.
- The eval harness and its scoring are tested (`pytest`) against a fake endpoint.

## Open decision

The prompt in `prompt.py` says "no heat in winter" is an emergency. The second
example labels a no-heat message `urgent`. One of them has to change before any
urgency score means anything.

## Run the tests

```bash
pip install -r requirements-dev.txt
```

```bash
pytest
```

## Deploy

Needs a Baseten account and its CLI.

```bash
cd truss && baseten model push --tail --wait
```

## Run the eval

```bash
export BASETEN_API_KEY=...
export BASETEN_MODEL_URL="https://model-<model_id>.api.baseten.co/environments/production/sync/v1"
python eval.py data/eval_examples.jsonl
```

Add `--concurrency 8` to measure throughput under load. Results go to
`eval_results.json`, which is git-ignored because it contains every message.

## What the eval reports, and how to read it

- **Urgency accuracy and emergency recall.** A missed emergency is the costly
  error, so recall on that class is shown on its own.
- **Valid JSON rate.** Output that is not a JSON object is a failed prediction.
  The harness does not fish a label out of free text. Output wrapped in a code
  fence is accepted and counted separately.
- **Latency p50 and p95**, measured at the client over warm requests. With
  fewer than 20 requests the p95 is just the slowest one, and the report says so.
- **First request time**, separately. After the model scales to zero this
  includes a cold start.
- **Cost per 1,000 requests** at the throughput the run sustained, from the GPU
  price per minute. This is the cost while a replica is warm and busy. It leaves
  out cold starts and the idle minutes billed before scale-down, which dominate
  at low traffic; the Baseten billing page has the real total.

Draft replies are not scored automatically. The first five are printed to read.

## Layout

```
prompt.py    the system prompt and label sets, shared by eval and serving
parse.py     strict parsing of model output
metrics.py   scoring functions
eval.py      the harness
truss/       Baseten deployment config
data/        labeled examples (put raw, un-anonymized messages in data/raw/, which is ignored)
tests/
```
