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
  the default 5 repeats). It reads `reference/` — three real Stitch outputs, `<name>.html` beside `<name>.png`. Ask
  before running it, and again after any change to the critic model or weights.

### 3. Run

Tell the user the cost first: **about $1–2 per screen** plus Stitch generations from the free-tier pool (edits count).
On their yes:

`dl run <screen>` — use `run_in_background` and the maximum timeout; a run takes minutes. Read the output when it
finishes. It prints each round, the stop reason, the versions, the spend and the run directory
(`<design>/runs/<date>-<screen>`).

Stop reasons: `pass` (no open blockers or majors), `converged` (two rounds without a real improvement),
`budget` (hit the round cap), `aborted` (exit 3 — saved versions are kept and still reviewable).

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

## Exit codes

| Code | Meaning | Do |
|---|---|---|
| 0 | done | continue |
| 1 | bad credentials, exhausted quota, unreadable design folder, failed smoke step | show the message; fix the cause |
| 2 | command typed wrong | read the printed usage |
| 3 | run aborted part-way | `report` the run; saved versions are kept |
