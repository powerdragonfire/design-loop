# design-loop

Generates a mobile screen design with Google Stitch, critiques it with a four-model committee plus a
deterministic critic that re-measures the rendered page, has a chair turn the open issues into one edit
prompt, and repeats until a noise-aware stopping rule fires. Every round is written to disk — screenshot,
HTML, digest, per-critic critique, open issues, prompt — and a self-contained HTML page shows them side by
side so you pick the version you want. Nothing is approved automatically.

## Prerequisites

- Node 22 or newer, and pnpm.
- `pnpm install`
- `pnpm exec playwright install chromium` — the deterministic critic renders each page to measure it.
- Stitch credentials: either `STITCH_API_KEY`, or both `STITCH_ACCESS_TOKEN` and `GOOGLE_CLOUD_PROJECT`.
  Plus `STITCH_PROJECT_ID`, the project generations land in.
- Anthropic credentials: `ANTHROPIC_API_KEY`, or a profile you have logged into with `ant auth login`.

Run everything as `pnpm design-loop <command>`.

## The design folder

Default `design/`, or pass `--design <dir>`. `test/fixtures/design/` is a working example of the layout.

```
design/
  config.json          sigma, maxRounds, convergence, model names, critic weights (must sum to 1.0),
                       criticMode ("api": this process calls Anthropic directly, or "agent": critiques
                       and chair verdicts come from Claude Code subagents instead)
  tokens.json          your design tokens: W3C DTCG ($value) or bare leaves both work
  brief.md             the product brief every critic is given
  screens/<name>.md    one spec per screen; `run <name>` needs screens/<name>.md
  directions.md        optional: one `## ` heading per art direction, fanned out into a candidate family each
  reference/           three real Stitch outputs, <name>.html beside <name>.png, for calibrate
  .design-loop/        written by the tool: quota.json, calibration.json
  runs/<date>-<screen>/  one directory per run:
    candidates/<id>/      every candidate stage row (screenshot, HTML, critiques), plus selection.json
    vNN/                  one directory per version, manifest.json, report.html
```

## Commands, in the order you run them

| Command | What it does | Cost |
| --- | --- | --- |
| `smoke` | Calls every live service once — a critic call, the same call again to prove the prompt cache hits, a chair call, a Stitch generate AND edit, then `measure()` on the real Stitch page — and prints PASS/FAIL/SKIP per step. Run it first. | 2 Stitch generations, ~$0.30 |
| `calibrate [--repeats N]` | Scores each `reference/` screen N times and writes the composite's noise floor into `config.json` as `sigma`, plus `.design-loop/calibration.json`. Re-run it after changing the critic model or the weights. | ~$2.20 at 5 repeats |
| `ab-distiller` | Critiques each reference screen twice, once from the digest and once from raw HTML, and lists the claims only the raw HTML produced. Whatever it lists is a field `measure`'s `STYLE_PROPS` is missing. | ~$8 |
| `sync-agents` | Writes `.claude/agents/design-loop-<critic>.md` and the chair's agent file from the critic rubrics baked into this build. Agent mode only — `run`/`step` refuse to dispatch a subagent against a stale one. Re-run it after upgrading. | free |
| `run <screen> [--date YYYY-MM-DD]` | Generates `families × (1 + variantsPerFamily)` candidates (config's `candidates` section — see [Generating more than one candidate](#generating-more-than-one-candidate); the default, `families: 1, variantsPerFamily: 0`, is one generation, today's behaviour), scores and selects one, promotes it to `v00`, then the edit loop. In `criticMode: "api"` it runs to completion, showing each step live, then prints the stop reason, the versions, the spend and the report path. In `criticMode: "agent"` it IS the first `step`: it suspends on the first round's critics and exits 10. | ~$1.06 per screen by default; ~$2.30 with the six-candidate example below, see the caveat there; not metered in agent mode |
| `step <runDir>` | Advances a suspended agent-mode run by one round. Everything already answered on disk is replayed for free; the first thing nobody has answered yet stops the run again and writes a `work-order.json` naming which subagents to dispatch. Keep calling it until it exits 0. | free (the round's own Stitch generation aside) |
| `inspect <versionDir> [--selector <css> \| --text <substring>]` | Looks up measured nodes from a version's digest by selector or text. The tool an agent-mode critic uses to check a claim against the real page before writing it — not usually run by hand. | free |
| `review <runDir>` | Builds the report, opens it, and asks which version to approve. | free |
| `report <runDir>` | Builds the report page and opens it, approving nothing. | free |
| `approve <runDir> <vNN\|cN>` | Records your pick — a version or a candidate — in the manifest and in `vNN/approved.json` or `candidates/<id>/approved.json`. | free |

`smoke`, `calibrate`, `ab-distiller` and `run` need credentials; the rest read the run directory only.

## Generating more than one candidate

Left alone, `run` does exactly what it always has: one Stitch generation, iterated by the edit loop. To have
it generate several independent readings of the screen spec and let the committee pick the best one before
the edit loop starts, add a `candidates` block to `config.json`:

```json
"candidates": {
  "families": 2,
  "variantsPerFamily": 2,
  "creativeRange": "EXPLORE",
  "aspects": ["LAYOUT", "COLOR_SCHEME"]
}
```

`families` is how many independent first generations to make — each from the bare spec, or from the spec plus
one `## ` section of `directions.md` if that file has enough sections. `variantsPerFamily` (0–5) asks Stitch for
that many variants of each family's generation via `generate_variants`, which nudges `aspects` within
`creativeRange`. The block above makes `2 × (1 + 2) = 6` candidates from two art directions. Every candidate is
measured and critiqued the same way a round is; the winner is copied to `v00` and the loop iterates it exactly
as before.

|  | default (no `candidates` block) | the block above |
| --- | --- | --- |
| Stitch generations | 1 + up to `maxRounds` | 6 + up to `maxRounds` |
| Cost per screen | ~$1.06 | ~$2.30 |

## Watching a run

Every command that spends money shows what it is doing as it does it, on **stderr**. The results (stop reason,
versions, spend, PASS/FAIL lines) stay on stdout, so `> results.txt` captures exactly those.

```
run home · design ../What-Now/design
critic claude-sonnet-5 · chair claude-opus-5 · sigma 1.8 · up to 5 edits
── candidates · 1 generated  ░░░░░░░░░░░░░░░░ ──
✓ stitch generate            0:58
✓ fetch html + image        401ms  41 KB html, 212 KB png
✓ measure                   600ms  1204 nodes
  ✓ typography        71  0:12
  ✓ layout            64  0:14
✓ critics                    0:31  4/4 ok
⠹ chair                      0:07  ← a live spinner and clock on a terminal
```

- **On a terminal** the current step is one live line with a spinner and a clock. **When piped** (CI, `| tee`,
  an agent) there are no control characters: timestamped `[13:31:02]` lines, and a `… still waiting on <step>`
  heartbeat every 30 seconds so a long Stitch wait does not look like a hang.
- **Retries show up**: `! stitch generate failed, attempt 2 of 3 in 1s: 503 …`, `! layout critic failed, retrying once`.
- `--quiet` prints results only. `--verbose` adds token counts per call. They cannot be combined.
- Every event is also written to `<runDir>/events.jsonl` (one JSON object per line: time, step, duration, detail),
  even with `--quiet`. From another terminal: `tail -f runs/<date>-<screen>/events.jsonl`.
- `smoke` shows its seven steps as `1/7 … 7/7`; `calibrate` shows each repeat as `home repeat 2/5`.

## Reading the report

`report.html` is one self-contained file — no network, no external assets — so open it straight from disk.

- The header gives the stop reason (`pass`, `converged`, `budget` or `aborted`), the noise floor sigma the
  stopping rule used, the spend, the committee's pick and your approval.
- A gallery above the versions shows every candidate the run was seeded from, each with its screenshot,
  family, composite, blocker count and gate result, and marks the winner. When the winner was not the
  highest-composite candidate, a line names why (the tie-break rule: everything within one sigma of the
  leader ties, and the fewest blockers wins). Absent entirely for a run from before the candidate stage.
- Each version shows its screenshot, its composite score and the delta against the previous round, whether
  the gate passed and why not, the per-critic scores, the prompt that produced it and which issues that edit
  was asked to fix.
- The issue list under a version is measured against the version it was **edited from**, which after a
  regression is the best version, not the previous round. An issue reads as persisted, new, resolved
  (verified), resolved (re-measured) or gone without verification. Only the first three are good news.
- A banner appears when a critic was dropped from a round, or when a version directory was incomplete.
- The page cannot approve for you: it prints the `approve` command to paste into a terminal.

## Claude Code skill

`skills/design-loop/SKILL.md` lets Claude drive this CLI for you. Install it once:

```
ln -s "$PWD/skills/design-loop" ~/.claude/skills/design-loop
```

Then ask Claude to "design the home screen with design-loop". It runs the commands above, summarises the report,
and waits for you to name the version to approve. It never approves on its own. If the tool lives somewhere other
than `~/Projects/design-loop`, set `DESIGN_LOOP_HOME`.

## Exit codes

- `0` — done.
- `1` — a failure: bad credentials, exhausted quota, an unreadable design folder, a failed smoke step.
- `2` — the command was typed wrong; the usage text is printed.
- `3` — the run was aborted part-way. Every version already written is kept and can still be reviewed.
- `10` — an agent-mode run is waiting: a `work-order.json` names the subagents to dispatch. Run `step` again after they have answered.

## Known limits in v1

- **Spacing literals are not token-checked.** Only colour, font size and border radius are compared against
  `tokens.json`; padding and margin are measured but never flagged.
- **`batchMode: true` is rejected at load.** Batch critiquing is not implemented.
- **Stitch's free tier is counted as one pool of 550.** It is really 350 Flash plus 200 Pro; this tool keeps
  one counter and warns at 80%. Edits count as generations.
- **Both cost figures above are likely to be optimistic on real pages**, whether you're on the one-candidate
  default or the six-candidate example. A real Stitch screen has far more nodes than the fixtures, and the
  digest is sent to four critics every candidate and every round. `smoke` prints the projected cost from the
  digest it actually measured — trust that number, and re-baseline from what `calibrate` cost.
- **Aliases in `tokens.json` are skipped, not resolved.** A leaf like `"{base.radius}"` leaves that category
  unchecked for the value rather than being treated as a literal.
- **A critic must cite a selector that exists.** Issues citing anything else are dropped and counted as the
  critic's hallucination rate, which the report shows. On pages without ids the selectors are long
  positional paths, so expect a non-zero rate.
- **Agent mode is not calibrated.** `calibrate` still runs through the API, so an agent-mode run
  inherits an API-mode sigma and warns loudly about it. Its spend is not metered either: subagent
  tokens never reach the CLI.
- **Agent mode cannot drop a critic.** In api mode, a critic that errors or fails validation is dropped
  from the round and the rest of the committee's weights are renormalised over the survivors. That path
  is only reachable by a critique that exists on disk and fails validation, and `SKILL.md` will not let
  Claude write one on a critic's behalf — a critique Claude wrote standing in for a critic that could not
  produce one would be a fabricated critique, not a degraded round. So in agent mode a critic that cannot
  answer halts the round instead of being dropped from it, and `step` keeps waiting until the operator
  decides what to do about it. Api mode is unaffected.
