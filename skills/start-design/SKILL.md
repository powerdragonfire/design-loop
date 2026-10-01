---
name: start-design
description: Use when the user wants to start designing a screen with design-loop — "/start-design", "design a new screen", "improve this Figma screen", "add the empty/error/loading state", "put this app screen into Figma". Briefs the user one question at a time (mode, target, content, component strategy, acceptance rules), writes screens/<name>.md and directions/<name>.md, and hands off the exact `design-loop run` commands.
---

# start-design

The brief step. Turns "I want a screen for X" into a spec and 2–3 art directions the loop can run, then hands off.
It does not run the loop; the `design-loop` skill does that.

`dl <command>` below means:

```bash
pnpm --dir "${DESIGN_LOOP_HOME:-$HOME/Projects/design-loop}" design-loop --design "<absolute design dir>" <command>
```

## How to ask

- **One question per message**, through AskUserQuestion, 2–4 options, recommended option first with
  "(Recommended)". Propose; don't interrogate. Draft from what you already know and ask the user to correct it.
- Real copy only: names, dates, prices and counts come from the user, the app's code or existing frames. Never
  lorem ipsum.
- Push back once, briefly, when a choice will hurt the run (two primary actions, a state that needs motion to make
  sense, a screen that is really a flow). Then go with the user's answer.

## Step 0: Check

1. Find the design folder: `~/.design-loop/apps.json` (ask which app if there are several), else `design/` in the
   current project.
2. Run `dl check --json`. Any `fail`: say which, tell the user to run `/design-setup`, and stop.
3. Read `project.json`, `brief.md`, `tokens.json` and the list of `screens/*.md`. Use them in every question below.

## Step 1: Mode

| Mode | When | v00 is | Run flag |
|---|---|---|---|
| New screen | Nothing exists yet | built from the spec | none |
| Improve existing | A frame exists and is not good enough | that frame, scored as it stands | `--from <nodeId>` |
| Missing states | A screen exists, a state of it does not (empty, loading, error, offline, permission denied, no results, dark) | a duplicate of the base frame, changed to the state | `--seed <nodeId>` |
| Port from app code | The screen exists in the app's code, not in Figma | built to match the code, then improved | none; the spec's `## Starting point` names the code file |

Not supported yet, so say so if asked: multi-screen flows (brief each screen as its own run), component-only work
(the loop scores whole screens), and tablet or landscape sizes (the loop designs for 393 x 852 portrait).

## Step 2: Target

- **Screen name**: kebab-case, e.g. `join-trip`. A missing state is `<screen>--<state>`, e.g. `join-trip--expired`.
  If `screens/<name>.md` exists, ask whether to revise it or pick a new name.
- **Improve / Missing states**: ask for the frame link, parse `node-id=123-456` to `123:456`, and call
  `get_screenshot` on it to confirm it is the right frame before going on.
- **Port**: list candidate files under `project.json` `appRepo/codeComponentsDir` that match the screen name and
  ask which one. Read it, and the components it imports, for the real content and structure.

## Step 3: Goal and content

1. Ask for the one thing the user of this screen must be able to do. One sentence.
2. Draft the content list from what you know: the app's code, existing frames, the hub screen that links here,
   `brief.md`. Show it as bullets with real copy and ask the user to correct it.
3. Missing states: ask which states (multi-select). Each one gets its own spec, and for each state ask what caused
   it and what the way out is (retry, go back, invite someone).

## Step 4: Component strategy (this is where variety comes from)

Propose 2–4 directions. Each is a **component-source strategy** plus a layout idea, with a one-line trade-off.
Recommend one. The user keeps 2–3, and each becomes one run.

What each source costs and buys:

| Source | Saves time | Variety | Use it for |
|---|---|---|---|
| Figma library (`project.json` `figma.componentsPageId`) | Most: already token-bound, and the names are the ones the critics read as controls | Low | The default for every direction |
| gluestack (`componentSources` has `gluestack`) | Medium: cheap to build in code, which the feasibility critic rewards | Low–medium | A "cheap to ship" direction. Figma has no gluestack kit, so it has to be drawn |
| makeitanimated (`make-it-animated-ai-workflow` skill) | Low in Figma: motion does not show in a static frame, and no critic can score it | High in feel, not in layout | A `Motion:` line inside a direction, never a direction of its own |
| Custom component | Least | Highest | One hero element where the library has a real gap. Name it so it can become a component later |

Good direction sets mix the sources. For example:
- "Library only, list layout": fastest, safest.
- "Library plus one custom hero card": the most distinct, with one new component to maintain.
- "gluestack-forward, compact": closest to shippable code.

## Step 5: Acceptance rules

1. Start from the shared rules: copy the `## Acceptance criteria` bullets that every existing spec in
   `screens/` repeats (tokens only, text at least 12px, solid fills, touch targets, spacing). If there are no other
   specs, draft them from `brief.md` and `tokens.json`.
2. Propose 2–3 rules for this screen only, in the form the critics can check, e.g. "Exactly one primary action",
   "'Not now' is visibly lesser than 'Join trip'", "No tab bar". The user edits them.

## Write

- `screens/<name>.md`: `# Title`, a short paragraph (who sees it, when), the content bullets with real copy, then:
  - `## Starting point`. For improve or missing states: "Frame <id> (<link>). Keep everything not named below."
    For port: "Matches `<code path>`." For new: "Nothing yet."
  - `## Acceptance criteria`: shared rules, then the screen rules.
- `directions/<name>.md`: one `## <Direction name>` per kept direction, with 2–4 lines of prose under it. Each
  direction names the components to use, from the library first, and an optional `Motion:` line. Order matters:
  direction 0 is the recommended one.
- Missing states: one spec per state, and the same directions file for each unless the user wants different ones.

Show the files' paths and the content bullets, not the whole files.

## Hand off

Print the exact commands, one run per direction, so the user can run them side by side and compare the reports:

```bash
dl run join-trip --direction 0
dl run join-trip --direction 1
```

Add `--from <nodeId>` (improve) or `--seed <nodeId>` (missing states) to every line. Then say: "Run these with the
`design-loop` skill. Each run stops on its own. Compare the reports, then approve one version."
