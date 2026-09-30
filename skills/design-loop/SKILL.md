---
name: design-loop
description: Use when the user wants to generate or refine a mobile screen design with Google Stitch and have it critiqued and iterated automatically — "design this screen", "run design-loop", "critique this Stitch design", "approve a design version", "calibrate design-loop". Runs the design-loop CLI, reads its report, and leaves the approval decision to the user.
---

# design-loop

Drives the `design-loop` CLI: Stitch generates a screen, a critique committee scores it, a chair writes one edit
prompt, and the loop repeats until a stopping rule fires. Every round is saved. **The user approves; you never do.**

## Where things are

- The tool: `$DESIGN_LOOP_HOME`, default `~/Projects/design-loop`. Confirm it exists and has `node_modules/`; if not,
  tell the user to run `pnpm install && pnpm exec playwright install chromium` there.
- The design folder: `design/` in the user's current project (or the path they name). Always pass it as an
  **absolute** path — the CLI runs from the tool's directory, so a relative path would resolve to the wrong place.
- Shell state does not persist between Bash calls, so write the full command each time:

```bash
pnpm --dir "${DESIGN_LOOP_HOME:-$HOME/Projects/design-loop}" design-loop --design "<absolute design dir>" <command>
```

Below, `dl <command>` means that whole line.

## Steps

### 1. Preflight (free, do every time)

- Credentials, checked without printing them:
  `for v in STITCH_PROJECT_ID ANTHROPIC_API_KEY STITCH_API_KEY; do printenv "$v" >/dev/null && echo "$v set" || echo "$v MISSING"; done`
  Stitch also accepts `STITCH_ACCESS_TOKEN` + `GOOGLE_CLOUD_PROJECT` in place of `STITCH_API_KEY`. `ANTHROPIC_API_KEY`
  may be replaced by an `ant auth login` profile. Never echo, log or write a key. If one is missing, tell the user which
  and stop.
- The design folder needs `config.json`, `tokens.json`, `brief.md` and `screens/<screen>.md`. If it is missing, offer to
  copy `test/fixtures/design/` from the tool as a template, then fill `tokens.json`, `brief.md` and the screen spec
  **with the user**. Do not invent their tokens or product brief.

### 2. First-time only

- `dl smoke` proves every live service works. Cost: about $0.30 and 2 Stitch generations. Ask before running it.
- `run` refuses while `config.json` has `"sigma": null`. That means `dl calibrate` is needed first (about $2.20 at
  the default 5 repeats). It reads `reference/` — three real outputs, `<name>.html` (Stitch) or `<name>.json` (a
  Figma node tree, e.g. a run's `vNN/screen.json`) beside `<name>.png`. Ask before running it, and again after any
  change to the critic model, the weights or the critic mode.
- In `criticMode: "agent"`, `dl calibrate` exits 10 with a work order under `.design-loop/calibrate-agent/`
  naming every critic for every repeat. Dispatch them exactly as for a run, then run `dl calibrate` again with the
  same `--repeats` to compute sigma. A run whose sigma was measured in the other mode warns about it.

### 3. Run

Tell the user the cost first: **about $1–2 per screen** plus Stitch generations from the free-tier pool (edits count).
On their yes:

`dl run <screen>` — use `run_in_background` and the maximum timeout; a run takes minutes. It prints timestamped
step lines on stderr as it goes (`stitch generate`, `critics`, `chair`, and a `… still waiting` heartbeat every 30s),
and the stop reason, versions, spend and run directory (`<design>/runs/<date>-<screen>`) on stdout. To report
progress while it runs, read the background output; to see what happened after a crash, read
`<runDir>/events.jsonl`. Don't kill a run that is only waiting.

Stop reasons: `pass` (no open blockers or majors), `converged` (two rounds that neither closed a blocker or
major nor raised the composite past the noise floor), `budget` (hit the round cap), `aborted` (exit 3 — saved
versions are kept and still reviewable). The committee's pick is the version with the fewest open blockers, then
majors, then the highest composite — not simply the highest score.

**In `criticMode: "agent"` the run stops after each generation and hands you the work instead.** The
critics and the chair are subagents you dispatch; `dl run` cannot call them itself, so it suspends.

Before the first agent-mode run, and again after every upgrade of the tool, run `dl sync-agents`. It writes
the `design-loop-*` agent definitions into `~/.claude/agents/`, where Claude Code finds them from any project;
`run` and `step` refuse to write a work order while those files are missing or out of date, and say so.
If the new agent types are not yet available to you, tell the user they may need to restart Claude Code.

1. Run `dl run <screen>` (the first step) or `dl step <runDir>` (every step after it).
2. Exit 0 — the run is finished; go to step 4 below. Exit 10 — read the `work-order.json` it printed.
3. For each unit in `units`, dispatch a subagent of the type named in `agent`. Give it the work order's
   `runDir` and `designDir`, the unit's `inputs` paths, its `output` path and, for a critic, its
   `nextIssueId`, and nothing else. Dispatch at most `concurrency` at a time. Wait for all of them, then go
   back to 1.

**If the user has asked for a workflow**, the tool ships one that does steps 1–3 for you:
`.claude/workflows/design-loop-drive.js` in the tool's checkout, run with
`{ scriptPath: "<tool>/.claude/workflows/design-loop-drive.js" }` and args `{ tool, designDir, runDir }` (or
`screen` instead of `runDir` to start). It returns `done`, `failed`, `stuck` (the same critic failed twice: tell
the user, as below), or `design` with the work order to build — build it, record the id, and run it again.

**The one exception: a `"kind": "design"` order is yours to do, not a subagent's.** It appears only when
`config.json` has `"generator": "figma"`. Its single unit has `"agent": null` because no `design-loop-*`
agent can reach Figma — you can, through the Figma MCP. Load the `figma-use` skill (and `figma-generate-design`)
before touching the file, and follow the order's `instruction`:

- **First generation** (`editFrom` is null): build a new frame on the order's `figma.pageId` from
  `designPrompt`, following `screenSpec`, `brief` and `tokens`. Reuse the file's existing variables, text
  styles and components before drawing anything new.
- **Edit** (`editFrom` is a node id): **duplicate** that frame and apply `designPrompt` — the chair's edit — to
  the COPY. Never edit `editFrom` in place: after a regression the loop builds from it again. `editFromVersion`
  and `editFromScreenshot` tell you which version you are building on; after a regression that is the best
  version, not the latest.
- Write the new frame's node id — one plain id, `123:456` — to the unit's `output` (`vNN/screen-id.txt`), then
  `dl step`. Recording an id is the one file you write in a Figma run; it is the design, not a judgement of it.

Build to what the loop can read (the README's "What the loop reads from your layers" has the full table):

- **Names decide what is tappable.** A control's layer, component or component set ends a `/` segment in a
  control word: Button, Link, Tab, Toggle, Switch, Chip, Action, Row, Field, Input, CTA. A container must NOT end
  in one: `Bottom bar`, not `Action bar`; `Invite URL`, not `Invite link`; `Trip tabs`, not `Trip Tab Bar`.
- **Accessibility comes from the file.** Headings: a headline/title text style. Image alt text and icon-only
  control names: the layer name (never `Rectangle 4`). Selected state: the `State=Selected` variant.
- **Pinned bars:** a 390×852 frame with vertical overflow, the bar its last child, `numberOfFixedChildren = 1`.
- **Clear the white fill** `figma.createAutoLayout()` gives every new frame, and **bind colours to variables**
  whose values are in `tokens.json` — token checks match exactly.
- **Override component colours that are not variable-bound** (a header's raw title colour) on every instance.

`step` reads the frame straight from Figma (needs `FIGMA_TOKEN`) and refuses an id equal to `editFrom`. If it
exits 1 naming the id, fix `screen-id.txt` and step again — nothing was finalised.

Paths in a work order are relative to `runDir` (or to `designDir` for `brief.md`, `tokens.json` and
`screens/`), both of which the file gives as absolute paths. An input with the value `null` is one this
agent is deliberately not shown — do not go and find it.

A step re-executes the run from round 0 every time. That is free: every screen already generated, every
page already measured and every round already scored is read back from the run directory, so only the
part that was waiting on you actually runs.

**Never write, edit or repair an inbox file yourself.** A critique you wrote is a fabricated critique: it
would be scored, carried into the next round and reported as a specialist's judgement. This is the same
rule as "the user approves, you never do", and it matters for the same reason.

**When an agent fails, the round waits — it is not dropped.** An absent inbox file means "has not answered
yet", so the next `dl step` suspends on the same round and the new work order names that same unit again.
Re-dispatch it; a transient failure clears. But if it keeps failing, `dl step` will keep reissuing it, and
there is no way to drop a critic from a round except by putting a file in its inbox — which is the one thing
you must not do. So **stop and tell the user**, saying which critic cannot answer and why. Whether to
re-dispatch again, abandon the run, or switch the folder to `criticMode: "api"` is their call. Never
manufacture an answer to get the loop moving.

### 4. Show the result

Run `dl report <runDir>`. **Do not use `review`** — it asks a question on stdin and will hang. `report` builds
`report.html` and opens it in the browser; it approves nothing.

Then summarise in chat, briefly:

- stop reason, rounds, spend
- a table of versions: score, gate pass or fail, and why it failed
- which version the committee ranked first
- any banner: a dropped critic, an incomplete version directory, a high hallucination rate

Issue statuses to trust: persisted, new, resolved (verified). Do **not** count "gone without verification" as fixed.

### 5. Approval — the user's call

Ask which version they want. You may recommend one and say why. Run
`dl approve <runDir> <version>` **only after the user names a version in their own message.** A recommendation from
you, or the committee's pick, is not approval.

## Never

- Approve, calibrate or run `ab-distiller` (about $8, tuning only) unless the user asked for it.
- Edit `tokens.json`, `config.json` weights, or a screen spec to make a gate pass. If the gate fails, report why.
- Retry a failed run in a loop. Every retry spends money and Stitch quota.
- Write, edit or repair a file under `runs/<run>/vNN/inbox/`. That is an agent's answer, not yours.
- In a Figma run, edit a design order's `editFrom` frame in place, or record the id of a frame you did not
  build for that order. The critics score whatever frame the id names.
- Re-run `dl step` while subagents are still working: it would write a work order for critics that are
  about to answer.

## Exit codes

| Code | Meaning | Do |
|---|---|---|
| 0 | done | continue |
| 1 | bad credentials, exhausted quota, unreadable design folder, failed smoke step | show the message; fix the cause |
| 2 | command typed wrong | read the printed usage |
| 3 | run aborted part-way | `report` the run; saved versions are kept |
| 10 | a work order is waiting (agent mode only) | dispatch the agents it names, then `dl step <runDir>` |
