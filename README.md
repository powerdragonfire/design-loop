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
- Designing in Figma instead (see [Designing in Figma](#designing-in-figma-instead-of-stitch)): a Figma
  personal access token with the read-only scope `file_content:read`, as `FIGMA_TOKEN`. No Stitch or
  Anthropic credentials are needed for a Figma run.

Run everything as `pnpm design-loop <command>`.

## The design folder

Default `design/`, or pass `--design <dir>`. `test/fixtures/design/` is a working example of the layout.

```
design/
  config.json          sigma, maxRounds, convergence, model names, critic weights (must sum to 1.0),
                       criticMode ("api": this process calls Anthropic directly, or "agent": critiques
                       and chair verdicts come from Claude Code subagents instead), generator ("stitch",
                       the default, or "figma") and, for Figma, figma: { fileKey, pageId }
  tokens.json          your design tokens: W3C DTCG ($value) or bare leaves both work
  brief.md             the product brief every critic is given
  screens/<name>.md    one spec per screen; `run <name>` needs screens/<name>.md
  directions.md        optional: one `## ` heading per art direction, fanned out into a candidate family each
  directions/<name>.md optional: the same, for one screen only; read before directions.md
  reference/           three real outputs, <name>.html (Stitch) or <name>.json (a Figma node tree) beside
                       <name>.png, for calibrate
  project.json         optional, written by /design-setup: the app, its repo, its DESIGN.md, the Figma
                       target and components pages, and which component sources briefs may draw from.
                       Read by the skills and `check`; nothing in it changes how a run behaves
  .design-loop/        written by the tool: quota.json, calibration.json
  runs/<date>-<screen>/  one directory per run:
    candidates/<id>/      every candidate stage row (screenshot, HTML, critiques), plus selection.json
    vNN/                  one directory per version, manifest.json, report.html
```

## Commands, in the order you run them

| Command | What it does | Cost |
| --- | --- | --- |
| `check [screen] [--json] [--offline]` | Lists everything a run needs, one row each, and what to run to fix it: the contract (config, tokens, brief), the screen spec, sigma and its calibration, the agent files, the Figma token, file and page (one small read; `--offline` skips it), `project.json`, whether `brief.md` carries a `DESIGN.md`'s rules, and the skills. Exit 1 on any failure. `--json` is for the skills. | free |
| `smoke` | Calls every live service once — a critic call, the same call again to prove the prompt cache hits, a chair call, a Stitch generate AND edit, then `measure()` on the real Stitch page — and prints PASS/FAIL/SKIP per step. Run it first. | 2 Stitch generations, ~$0.30 |
| `calibrate [--repeats N]` | Scores each `reference/` screen N times and writes the composite's noise floor into `config.json` as `sigma`, plus `.design-loop/calibration.json` (which records the critic mode it was measured in). Re-run it after changing the critic model, the weights or the critic mode. In `criticMode: "agent"` it works like `step`: it writes one `work-order.json` under `.design-loop/calibrate-agent/` naming every critic for every repeat, exits 10, and once they have answered, run it again (same `--repeats`) to compute sigma. | ~$2.20 at 5 repeats; not metered in agent mode |
| `ab-distiller` | Critiques each reference screen twice, once from the digest and once from raw HTML, and lists the claims only the raw HTML produced. Whatever it lists is a field `measure`'s `STYLE_PROPS` is missing. | ~$8 |
| `sync-agents [--agents-dir <dir>]` | Writes `design-loop-<critic>.md` and the chair's agent file from the critic rubrics baked into this build, into `~/.claude/agents/` so Claude Code finds them from any project. Agent mode only — `run`/`step` refuse to dispatch a subagent against a stale one, and check the same directory (pass them the same `--agents-dir` if you override it). Re-run it after upgrading. The copies under this repo's `.claude/agents/` are a reference, not what is dispatched. | free |
| `run <screen> [--date YYYY-MM-DD]` | Generates `families × (1 + variantsPerFamily)` candidates (config's `candidates` section — see [Generating more than one candidate](#generating-more-than-one-candidate); the default, `families: 1, variantsPerFamily: 0`, is one generation, today's behaviour), scores and selects one, promotes it to `v00`, then the edit loop. In `criticMode: "api"` it runs to completion, showing each step live, then prints the stop reason, the versions, the spend and the report path. In `criticMode: "agent"` it IS the first `step`: with the default single candidate it generates `v00`, suspends on its critics and exits 10. Agent mode refuses a config that asks for more than one candidate (see Known limits). | ~$1.06 per screen by default; ~$2.30 with the six-candidate example below, see the caveat there; not metered in agent mode |
| `run <screen> --direction N` | Starts from art direction N of `directions/<screen>.md` instead of the first. A Figma or agent-mode run has one candidate, so this is how it explores directions: one run per direction, compared in their reports. | as `run` |
| `run <screen> --from <nodeId>` | Figma: improve a frame that already exists. It is read and scored as `v00`, with no design order; every edit duplicates it, so the original is never changed. | as `run` |
| `run <screen> --seed <nodeId>` | Figma: a missing state of an existing screen. `v00`'s design order says to duplicate this frame and apply the spec to the copy, instead of building from nothing. | as `run` |
| `step <runDir>` | Advances a suspended agent-mode run by one round. Everything already answered on disk is replayed for free; the first thing nobody has answered yet stops the run again and writes a `work-order.json` naming which subagents to dispatch. Keep calling it until it exits 0 — or let the `design-loop-drive` workflow (`.claude/workflows/`) step and dispatch for you; it returns at each Figma design order. | free (the round's own Stitch generation aside) |
| `inspect <versionDir> [--selector <css> \| --text <substring>]` | Looks up measured nodes from a version's digest by selector or text, for a person checking a critic's claim against the real page. Agent-mode critics have no shell; they read the same `vNN/digest.json` directly. | free |
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
one `## ` section of `directions/<screen>.md` (or, if the screen has none, `directions.md`) if that file has
enough sections. An agent-mode run's single generation gets the first section. `variantsPerFamily` (0–5) asks Stitch for
that many variants of each family's generation via `generate_variants`, which nudges `aspects` within
`creativeRange`. The block above makes `2 × (1 + 2) = 6` candidates from two art directions. Every candidate is
measured and critiqued the same way a round is; the winner is copied to `v00` and the loop iterates it exactly
as before.

|  | default (no `candidates` block) | the block above |
| --- | --- | --- |
| Stitch generations | 1 + up to `maxRounds` | 6 + up to `maxRounds` |
| Cost per screen | ~$1.06 | ~$2.30 |

## Designing in Figma instead of Stitch

Set `"generator": "figma"` and the loop builds each version as a frame in your own Figma file, bound to
your own design system, instead of asking Stitch to generate HTML. Everything after generation — measurement,
the committee, the chair, the stopping rule, the report — is unchanged.

```json
"criticMode": "agent",
"generator": "figma",
"figma": { "fileKey": "Hd1q4ePvrHOmZerZZNmk9b", "pageId": "266:2" },
"candidates": { "families": 1, "variantsPerFamily": 0 }
```

**Nothing here can create a frame for you.** Figma's REST API is read-only for designs; creating and editing
frames is the Plugin API, which runs inside Figma. So a Figma run suspends for every generation and edit,
exactly as agent mode suspends for critiques, and the session driving the loop (Claude Code with the Figma
MCP) does the design work:

```
run settings       → work order kind "design" → exit 10
                     build the frame; write its node id to v00/screen-id.txt
step <runDir>      → reads the frame from Figma, measures it, suspends on the critics → exit 10
                     dispatch the critics; step; dispatch the chair; step
step <runDir>      → work order kind "design" for v01 → exit 10
                     DUPLICATE the frame it names, apply the edit to the copy, record the copy's id
step <runDir>      → … until exit 0
```

What the design work order asks, and what `step` enforces:

- **One plain frame id per `screen-id.txt`**, `123:456`. A Figma link's `123-456` is accepted too.
- **Duplicate, never edit in place.** After a regression the loop builds from the best version's frame
  again, so an in-place edit would destroy it. `step` refuses an id equal to the order's `editFrom`.
- **The frame is read once and frozen.** Before the loop runs, `step` fetches each newly recorded frame and
  writes its node tree and PNG into the version directory. A mistyped id or a Figma outage fails that `step`
  plainly (exit 1, nothing finalised): correct the id and step again. A later tweak in Figma never changes
  what an earlier version was scored on.

Differences from a Stitch run:

- **Agent mode only**, so one candidate only, and it costs no Stitch quota and no Anthropic credit.
- **The frame is measured from Figma's own node tree**, not by rendering HTML in Chromium, so bounds, fills,
  font sizes and radii are exact. Selectors are layer-name paths (`Content>Tile_grid>Tile_/_Notifications`),
  which survive the duplicate each round makes. The node tree is stored as `vNN/screen.json` and handed to the
  critics as `nodeTree`.
- **The chair is told it is writing for Figma**, so it asks for layer names, text styles, variants and fixed
  children rather than `aria-*` attributes or markup.

### What the loop reads from your layers

Figma has no HTML semantics, so the serialiser reads them from how the file is built. Build to these and the
checks and critics see what you meant:

| To get | Do this in Figma |
| --- | --- |
| A tap target | Give it a prototype interaction, or name the layer, its component or its component set with a control word as the **last word** of a `/` segment: Button, Btn, Link, Tab, Toggle, Switch, Chip, Action, Row, Field, Input, CTA (`Primary Button`, `Tab / Today`, `Tab Bar Item`). |
| A container that is NOT one big tap target | Don't end its name in a control word (`Action bar`, `Bottom bar`, `Trip tabs` are fine). A control-named layer that holds two or more controls is treated as a container anyway. |
| A heading | Set the text in a text style whose name contains headline, heading, title or display, or start the layer name with "Heading". |
| An image's alt text | The layer name of the node with the image fill (`Lisbon tram on Rua da Graça`, not `Rectangle 4`). |
| An icon-only control's accessible name | The instance's layer name (`Close`, `Copy link`). A control that shows its own text needs nothing. |
| A selected state | Use the component's `State=Selected` (or `Active`, `On`, `Checked`) variant. |
| A bar pinned over scrolling content | A device-height frame with vertical overflow, the bar as its last child with `numberOfFixedChildren` covering it. On a screen that scrolls, only pinned controls are checked against the 34px home-indicator inset. |

Also: `figma.createAutoLayout()` frames start with a white fill, so clear it on every layout container, and
colours are token-checked exactly, so bind to the variables whose values are in `tokens.json`.

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

Three skills let Claude drive this tool for you:

- `/design-setup` asks which app you are designing, connects its Figma file and pages, folds a `DESIGN.md` into
  `brief.md`, writes `project.json`, and stops when `check` is green.
- `/start-design` is the brief. It asks what kind of work this is (a new screen, improving an existing frame, the
  missing states of a screen, or porting a screen from the app's code), the content, and two or three
  component-source directions. It then writes `screens/<name>.md` and `directions/<name>.md` and prints one `run`
  command per direction.
- `design-loop` runs the loop, summarises the report, and waits for you to approve.

### Install the skills

```
for s in design-loop design-setup start-design; do ln -s "$PWD/skills/$s" ~/.claude/skills/$s; done
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

- **`smoke` and `ab-distiller` are Stitch-only.** `calibrate` measures Figma reference screens
  (`reference/<name>.json`) natively in agent mode; the other two still render HTML in Chromium.
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
- **Agent-mode spend is not metered.** Subagent tokens never reach the CLI. Calibrate agent-mode folders
  with `calibrate` in agent mode: a sigma measured through the API describes a different committee, and a run
  says so loudly.
- **Agent mode cannot drop a critic.** In API mode, a critic that errors or fails validation is dropped
  from the round and the rest of the committee's weights are renormalised over the survivors. That path
  is only reachable by a critique that exists on disk and fails validation, and `SKILL.md` will not let
  Claude write one on a critic's behalf — a critique Claude wrote standing in for a critic that could not
  produce one would be a fabricated critique, not a degraded round. So in agent mode a critic that cannot
  answer halts the round instead of being dropped from it, and `step` keeps waiting until the operator
  decides what to do about it. API mode is unaffected.
- **An agent's file access is limited by its brief, not enforced.** The generated agents get `Read`, `Grep`,
  `Glob` and `Write` and no shell, so no network. But agent frontmatter cannot scope a tool to a path, so
  nothing but the brief stops a critic reading beyond its inputs or writing a file other than its own output,
  including another critic's inbox file or the chair's.
- **A dropped critic's answer is not archived.** Answered critics and the chair are replayed from an archive,
  but a critic dropped for a malformed file is re-read from `inbox/` on every replay. Delete that file after
  the round is scored and a later `step` suspends inside an already-scored version; replace it with a valid
  one and the replay scores that round with four critics while `vNN/composite.json` records three, so the
  manifest and the version directory disagree. This should be fixed before agent mode is used for any run
  whose manifest matters.
- **Agent mode runs one candidate only.** `criticMode: "agent"` with `candidates.families` above 1 or
  `candidates.variantsPerFamily` above 0 is rejected at load, before anything is generated. Work orders and the
  resume layer only know version directories, so there is nowhere yet to dispatch a candidate's critics from.
  Set `"families": 1` and `"variantsPerFamily": 0`, or use `"criticMode": "api"`. The one candidate is still
  recorded as `c0` and wins its one-row selection, so the report and `approve c0` work as they do in API mode.
- **Nothing stops two `step` processes writing one run at once.** Both would pay for the same Stitch edit and
  interleave their writes in one `vNN/`. Run one `step` at a time per run directory. This too should be fixed
  before agent mode is used for any run whose manifest matters.
