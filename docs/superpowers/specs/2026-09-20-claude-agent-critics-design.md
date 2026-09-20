# Claude Code agents as the critique committee

## Problem

The committee is invisible. `runCommittee` fans four critics out with `Promise.allSettled` and the
only trace is two lines of progress output and a score. When a critic disagrees with the others, or
hallucinates a selector, there is nothing to open and read — the reasoning never left the API call.

Two consequences:

- **Nothing to inspect.** `validateEvidence` records a hallucination rate per critic in the manifest,
  but a high rate is a number with no attached work to examine.
- **The digest is a ceiling.** Critics see `distill(doc)` and a screenshot. The `ab-distiller` command
  exists precisely because that projection loses claims the raw HTML would have supported. A critic
  that cannot look at anything cannot recover them.

Running each critic as a Claude Code subagent fixes both: the dispatch is visible in the session, and
an agent with tools can read the HTML, query a selector, and check its own evidence before it claims.

## What this changes

`design-loop run` stops being one process that completes. It becomes a resumable step machine:

```
dl run <screen>           -> claims the run directory, generates v00, suspends.
                             Prints the runDir, writes v00/work-order.json, exits 10.
  [Claude dispatches one subagent per critic; each writes v00/inbox/<critic>.json]
dl step <runDir>          -> ingests, validates, scores, generates the next edit, exits 10
  ...
dl step <runDir>          -> stopping rule fires, finalises, exits 0
```

`run` stays the entry point — it is the only command that may claim a new run directory, so
`openRun`'s collision handling is untouched. `step` only ever advances a directory that exists. In
API mode `run` behaves exactly as it does today and never exits 10.

The stopping rule, weight renormalisation, regression-against-best, evidence validation and the
chair's three-change cap all stay in tested TypeScript. Only the transport of a critique changes.

## Approach: replay, not checkpoint

The obvious design is a serialised state machine: write `carried`, `prevOpen`, `prevDoc`, `parent`
and the usage totals to a `state.json`, resume from exactly there. Rejected — it duplicates on disk
what `writeVersion` already persists, and every field added to `VersionRecord` later becomes a
migration.

Instead, **each `dl step` re-executes `runScreen` from round 0**, with a resume layer that
short-circuits any step whose output is already on disk. The loop is deterministic given the same
inputs — `composite`, `gate`, `decide`, `validateEvidence`, `promoteResolutions` and `groupTokenIssues`
are all pure — so replaying it reproduces the same state without recomputing anything expensive:

| step | on replay |
| --- | --- |
| `generator.generate` / `handle.edit` | returns a handle rebuilt from `vNN/screen-id.txt`; no Stitch call, no quota |
| `getHtml` / `getImage` | read `vNN/screen.html`, `vNN/screen.png` |
| `measure(html)` | read `vNN/digest.json`, which already holds the full `MeasuredDoc` |
| `runCommittee` | read `vNN/critiques/*.json` |
| `chair(...)` | read `vNN/chair.json` |
| `run.writeVersion` | skipped; the record is rebuilt from disk |

Replay therefore costs a few file reads per completed round and nothing else. Nothing is paid for
twice, and crash recovery — which today loses every in-flight round — comes free.

When replay reaches a round whose critiques are not on disk, the committee client throws
`WorkOrderPending`. `dl step` catches it, writes the work order, and exits 10.

### Why not keep one blocking process

A long-lived CLI waiting on a watched directory needs no serialisation, but it hangs for minutes while
Claude polls it, and a crash still loses the run. Replay is strictly better for the same reason
`openExistingRun` already exists: the run directory is the state.

## The suspend boundary

Exactly two places in `runScreen` call a model: the `progress.phase("critics", ...)` call and the
`progress.phase("chair", ...)` call. Each gets an agent-mode client that suspends rather than calls.

```ts
class WorkOrderPending extends Error {
  constructor(readonly kind: "critics" | "chair", readonly version: string, readonly units: WorkUnit[]) {}
}
```

`AgentLlmClient.critique()` reads `vNN/inbox/<critic>.json`. Present and valid — return it. Absent —
collect it into the pending set and suspend once the whole committee has been asked, so a work order
always names every missing critic rather than one at a time.

`AgentChairClient.synthesise()` does the same against `vNN/inbox/chair.json`.

`chair.json` and `inbox/chair.json` hold the **same shape** — `{ prompt, changeIds }`, exactly what
`synthesise` returns. The archived copy is the accepted inbox file. `chair()`'s ranking and
`MAX_CHANGES` truncation are pure, so they are re-applied on every replay rather than stored; a
`requested` count recovered from a stored total could disagree with the ids beside it, and this way
it cannot.

## What the store must additionally persist

Replay needs three things `writeVersion` does not write today, plus three the agents need as inputs:

| file | why |
| --- | --- |
| `vNN/screen-id.txt` | the Stitch screen id; a `Screen` handle cannot serialise, and `.edit()` needs only the id |
| `vNN/chair.json` | the chair's raw `synthesise` output, so a replayed round does not re-pay it |
| `vNN/digest.txt` | the distilled digest string; `digest.json` holds the `MeasuredDoc`, not `distill(doc)` |
| `vNN/carried-issues.json` | the `openIssues` the round was given (derivable on replay, but the agent needs a file) |
| `vNN/measurements.json` | the deterministic findings shown to the accessibility critic only |
| `vNN/inbox/` | raw agent output, before validation |

`inbox/` and `critiques/` stay separate on purpose. `critiques/` means *validated and scored*.
`inbox/` means *what an agent wrote*, which is untrusted input from a file.

### Rehydrating a Stitch screen

`createSdkProject`'s `screenOf` builds a screen from a `ScreenData`; `edit` needs only `id` and
`projectId`. So `screenFromId(projectId, id)` is a two-line addition.

Its `getHtml()` and `getImage()` must **throw**, not fall back. They would route to `get_screen`,
which the live API rejects with `Invalid Argument` for its own documented arguments. The loop never
needs them on a rehydrated handle — the HTML and PNG are on disk — so a throw turns a future misuse
into an error instead of a mystery.

## The work order

`vNN/work-order.json`, rewritten each time a step suspends:

```json
{
  "kind": "critics",
  "version": "v00",
  "screen": "home",
  "designDir": "/abs/path/design",
  "runDir": "/abs/path/design/runs/2026-09-20-home",
  "concurrency": 4,
  "units": [
    {
      "critic": "typography",
      "agent": "design-loop-typography",
      "output": "v00/inbox/typography.json",
      "inputs": {
        "digest": "v00/digest.txt",
        "screenshot": "v00/screen.png",
        "html": "v00/screen.html",
        "screenSpec": "screens/home.md",
        "brief": "brief.md",
        "tokens": "tokens.json",
        "carriedIssues": "v00/carried-issues.json",
        "measurements": null,
        "nextIssueId": "typography-003"
      }
    }
  ]
}
```

`measurements` is non-null for `accessibility` only, matching the current rule in `runScreen`. Paths
are relative to `runDir` or `designDir` so the file survives the directory being moved.

A chair work order has `kind: "chair"` and one unit, whose inputs carry the best version's screenshot,
the grouped open issues and the regression block when there is one.

## Ingest: validation moves out of the client

`parseCritique`, `CRITIQUE_SCHEMA`, `ISSUE_SCHEMA` and the id de-duplication logic currently live
inside `src/critics/llm.ts` and run as part of the API call. They move to `src/critics/schema.ts` and
are imported by both clients, because in agent mode they are the only thing standing between a file an
agent wrote and the scoring code.

Everything downstream is unchanged and still load-bearing:

- `validateEvidence` drops issues whose selector is absent from the measured doc and records the rate.
- `promoteResolutions` re-measures claimed fixes; a model still never verifies itself.
- `chair()` still ranks by severity/effort and truncates to `MAX_CHANGES`, rebuilding the prompt from
  the kept issues when the agent overran. The cap is in code because the model cannot be trusted with
  it — that reasoning applies at least as strongly to an agent.

An invalid or missing inbox file is **not** fatal. It is the existing dropped-critic path: recorded in
`degradations`, weights renormalised over the survivors, the round scored on who is left. A round with
zero valid critiques still fails as it does today.

## Tools for critics

Each critic agent gets:

- `Read`, `Grep`, `Glob`, scoped by permission rules to the run directory and the design folder.
- `Write`, for its own output path only.
- `Bash(design-loop inspect:*)` — a new read-only subcommand.

No network, no other Bash. Scoping is enforced by allow-rules in `.claude/settings.json`, not by the
agent frontmatter's `tools:` list, which controls availability rather than paths.

### `dl inspect`

```
dl inspect <runDir>/<version> --selector "<css>"     -> the measured nodes as JSON
dl inspect <runDir>/<version> --text "<substring>"   -> nodes whose text matches
```

It queries the stored `MeasuredDoc` in `digest.json`. No Playwright, no re-render, no cost. This is
the direct answer to what `ab-distiller` measures: the critic can recover a field the digest dropped
without being handed the whole 41 KB HTML by default.

### The success criterion

The manifest already records `hallucinationRate` per critic. A critic that can check a selector before
claiming it should hallucinate less. Agent mode versus API mode on the same reference screens is a
direct, already-instrumented comparison — and the first thing to look at after this ships.

## Agent definitions are generated

`dl sync-agents` writes `.claude/agents/design-loop-<critic>.md`, frontmatter plus the body of
`src/critics/prompts/<critic>.md`, so the rubric has one source of truth and cannot drift between the
two modes. A fifth file is written for the chair from the `INSTRUCTIONS` block in `src/chair/chair.ts`,
which moves to `src/chair/prompts/chair.md` for the same reason.

Each generated file carries a `<!-- generated by dl sync-agents; edit src/critics/prompts/… -->`
header, and `dl step` refuses to write a work order when a generated agent file is missing or stale
against its source — a critic silently running an old rubric is the failure this prevents.

## Calibration: sigma is mode-scoped

`sigma` is the noise floor of the critic setup. Tool access changes the score distribution far more
than a weight tweak does, so a sigma measured in one mode does not describe the other.

- `Config` gains `criticMode: "api" | "agent"`, defaulting to `"api"` so every existing design folder
  keeps its behaviour.
- `Calibration` gains the same field, and `calibrate` records it.
- `readCalibration` warns on a model or weight mismatch today. A **mode** mismatch is different in
  kind: `run` refuses rather than warns.
- `calibrate` needs the same suspend/resume treatment, since it scores reference screens with the
  same committee. It reuses `dl step`'s machinery over a `calibration/` directory rather than a run.

That refusal is the one place this design is deliberately stricter than the surrounding code. If it
proves annoying in practice it can be demoted to a warning — but not before the first agent-mode
calibration exists to compare against.

## Cost accounting stays honest

Subagent tokens are not reported to the CLI. `spend.usd` would read `$0`, which is a lie a report
would repeat.

- `Spend` gains `criticMode`, and `usd` becomes `number | null`.
- In agent mode `usd` is `null` and the report prints "not metered (agent mode)".
- `runScreen`'s preflight `costUsd(cfg.models.critic, zero)` — which exists to reject an unpriced
  model name — is skipped in agent mode.
- Optionally, an agent may write `vNN/inbox/<critic>.usage.json`. When every unit in a round supplies
  one, that round's spend is metered; when any is missing, the run's `usd` stays `null`. Partial
  totals are worse than none.

## The skill

`skills/design-loop/SKILL.md` gains the loop, and one hard rule.

```
1. dl step <runDir>
2. exit 0  -> done; go to "Show the result"
   exit 10 -> read vNN/work-order.json
3. Dispatch one subagent per unit, up to `concurrency` at a time, using the named agent type.
   Give each the unit's inputs and its output path. Nothing else.
4. Wait for all of them. Go to 1.
```

**Never write, edit or repair an inbox file yourself.** A critique Claude wrote is a fabricated
critique — it would be scored, carried forward and reported as a specialist's judgement. If an agent
fails, leave the file absent and let `dl step` record the dropped critic. This sits beside the
existing "the user approves, you never do" rule and has the same shape: the tool's integrity depends
on a boundary Claude does not cross.

The skill also stops using `run_in_background` for the loop, since each step is now short.

## Composition with the candidate stage

`docs/superpowers/specs/2026-09-20-candidate-stage-design.md` is written but unimplemented. It fans out
six candidates, each scored by the full committee — 24 critiques before the loop starts. That is where
visible dispatch earns the most, and it is the reason the work order is a list of units rather than a
fixed four.

Neither spec blocks the other. The candidate stage calls `runCommittee` per candidate, so it inherits
the agent client without changes; its work orders carry `kind: "critics"` with a `candidate` field
instead of `version`. Order of implementation is free — but if both are wanted, build this one first,
so the candidate stage is developed against a committee you can watch.

`concurrency` defaults to 4 (one committee) rather than 24. Twenty-four agents each reading a 41 KB
HTML is a large amount of context for a small amount of parallelism.

## Code shape

New:

- `src/critics/schema.ts` — `CRITIQUE_SCHEMA`, `parseCritique`, `nextIssueId`, moved verbatim from `llm.ts`.
- `src/critics/agent.ts` — `AgentLlmClient`, `WorkOrderPending`.
- `src/chair/agent.ts` — `AgentChairClient`.
- `src/cli/step.ts` — the `step` command: build the resume layer, run `runScreen`, catch the suspend, write the work order, exit 10.
- `src/cli/resume.ts` — `resumingGenerator(runDir, inner)` and `resumingRun(run)`, the short-circuit layer.
- `src/cli/inspect.ts` — `dl inspect`.
- `src/cli/agents.ts` — `dl sync-agents` and the staleness check.
- `src/chair/prompts/chair.md` — the chair rubric, extracted.

Changed:

- `src/critics/llm.ts` — imports from `schema.ts`; otherwise untouched.
- `src/store/store.ts` — the six new files above; `readVersion(runDir, version)` rebuilding a `VersionRecord`.
- `src/stitch/sdk.ts` — `screenFromId`.
- `src/contract/load.ts` — `criticMode` in the config schema.
- `src/cli/calibration.ts` — `criticMode` on `Calibration`, the refusal.
- `src/cli/main.ts` — `step`, `inspect`, `sync-agents`; exit code 10; `run` suspending in agent mode.
- `README.md` — the new commands, `criticMode`, and exit code 10 beside the existing 0/1/2/3.
- `src/report/report.ts` — unmetered spend.
- `src/types.ts` — `Config.criticMode`, `Spend.usd: number | null`.

`src/cli/run.ts` changes only in which clients it is handed. That is the measure of whether this design
is right: if `runScreen` needs restructuring, the suspend boundary was drawn in the wrong place.

## Testing

The load-bearing test is **replay equivalence**:

> Run a screen to completion in API mode with `FakeGenerator` and a scripted `LlmClient`. Seed a second
> run directory's `inbox/` with those same critiques. Drive it with repeated `dl step`. Assert the two
> `manifest.json` files are identical except for `spend`.

If that passes, the resume layer is transparent and the stopping rule is provably unaffected.

Beyond it:

- `resume.test.ts` — a replayed round makes no Stitch call, reserves no quota, and re-measures nothing.
- `agent.test.ts` — a missing inbox file suspends; a present one returns; a malformed one is a dropped
  critic, not a crash; a work order names every missing critic at once, not the first.
- `schema.test.ts` — the moved `parseCritique` tests, unchanged, now covering the file path too.
- `step.test.ts` — exit 10 with a pending order, exit 0 when finalised, exit 1 on a stale agent file.
- `calibration.test.ts` — a mode mismatch refuses; a model mismatch still only warns.
- `inspect.test.ts` — selector and text queries against a fixture `digest.json`.
- An end-to-end check that `criticMode: "api"` (the default) produces byte-identical behaviour to today.

## Out of scope

- Agents deciding anything. They produce a `Critique`; scoring, the gate, the cap and the stopping
  rule stay in code.
- Metering subagent cost as a first-class number. Optional and best-effort, or `null`.
- Running the deterministic critic as an agent. It is a measurement, not an opinion.
- Replacing API mode. It stays the default and the CI path.
- Parallelising rounds. The loop is still sequential; only the committee within a round fans out.

## Risks

1. **Agents are chattier and slower than an API call.** Four subagents with tools will cost more
   wall-clock and more context than four structured-output calls. Mitigated by pointing the work order
   at the digest first and making the raw HTML opt-in, but this is a real trade for the visibility and
   the lower hallucination rate. Measure it on the first calibration.
2. **A stale `.claude/agents/` file silently runs an old rubric.** Mitigated by the generation header
   and the staleness refusal in `dl step`; both must exist from the first commit, not later.
3. **`get_screen` is broken upstream.** Handled by never calling it — but if a future change needs HTML
   for a version not on disk, there is no route to it today.
4. **Replay drifts if anything in the loop becomes non-deterministic.** The replay-equivalence test is
   the guard; any future randomness or wall-clock dependence in the scoring path breaks it loudly.
