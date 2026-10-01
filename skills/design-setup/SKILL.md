---
name: design-setup
description: Use when the user wants to set up design-loop for an app, says "/design-setup", "set up design-loop", "which app am I designing", "connect design-loop to Figma", or when `design-loop check` reports failures. Interviews the user one question at a time, then writes the design folder's project.json and fixes what `check` flags. Run before /start-design.
---

# design-setup

Gets a design folder to the point where `design-loop check` is green, by asking the user only about what is
missing or wrong. Re-runnable: everything already set is confirmed, not re-asked.

`dl <command>` below means:

```bash
pnpm --dir "${DESIGN_LOOP_HOME:-$HOME/Projects/design-loop}" design-loop --design "<absolute design dir>" <command>
```

## How to ask

Borrowed from brainstorming, without its design-doc ending:

- **One question per message**, through AskUserQuestion, with 2–4 options. Put the recommended one first and
  label it "(Recommended)". The user can always type "Other".
- Ask only what `check`, the files, or Figma cannot tell you. Read first, then confirm ("I found X. Use it?").
- Never invent tokens, brief content or ids. Every value written comes from the user, a file, or Figma.
- Edit files with targeted edits, never whole-file rewrites of something the user wrote.

## Step 0: Where are we

1. Read `~/.design-loop/apps.json` if it exists (`{ "<app>": "<absolute design dir>" }`).
2. Ask **which app**: one option per registered app, plus "A new app". For a new app, ask for its repo path and
   use `<repo>/design` as the design folder.
3. Run `dl check --json`. Greet with one line per area: what is already fine, what needs fixing. Then work through
   only the sections below that have a `fail` or `warn`, in this order.

`--section <name>` in the user's request (`app`, `figma`, `credentials`, `contract`, `design-doc`, `calibration`,
`project`) runs that section alone.

## Sections

### app
Registers the folder: add `"<app>": "<abs design dir>"` to `~/.design-loop/apps.json` (create it if missing).

### figma
For a Figma generator (`"generator": "figma"` in `config.json`):
1. Ask for the Figma file link. Parse `fileKey` from `figma.com/design/<fileKey>/…`, and a `node-id=123-456` in the
   link as a page or frame id (`123:456`).
2. Use the Figma MCP (`get_metadata` on the file) to list pages. Ask which page new screens are built on
   (`config.json` `figma.pageId`) and which page holds the component library (`project.json`
   `figma.componentsPageId`). Recommend the page with the most COMPONENT / COMPONENT_SET nodes as the library.
3. Write `figma.fileKey` and `figma.pageId` into `config.json`, and set `"criticMode": "agent"` (Figma requires it).

### credentials
- `FIGMA_TOKEN` must be set in the shell that runs `dl` (check with `printenv FIGMA_TOKEN >/dev/null`; never print
  it). If missing, tell the user to create a personal access token with the `file_content:read` scope and add
  `export FIGMA_TOKEN=…` to their shell profile. You cannot set it for them.
- Agents stale or missing: ask before running `dl sync-agents`. It writes `~/.claude/agents/design-loop-*.md`.

### contract
`config.json`, `tokens.json`, `brief.md`. If the folder does not exist, offer to copy the tool's
`test/fixtures/design/` as a template. Then fill `tokens.json` and `brief.md` **with** the user: ask for the
product in two sentences, who uses it, and the tone, and draft `brief.md` from their answers for them to approve.

### design-doc
`check` warns when a `DESIGN.md` exists but `brief.md` never mentions it. The loop reads `brief.md`, never
`DESIGN.md`, so rules that live only there are invisible to the designer and the critics.
1. Read `DESIGN.md` and pull out the rules a screen must obey (fonts, type scale, radius, spacing, contrast fixes,
   where special treatments may and may not go). Skip provenance and history.
2. Show them as a numbered list. Ask: "Add all to brief.md / pick some / skip".
3. Append them to `brief.md` under `## Design system (from DESIGN.md)`. The file name in that heading is what
   `check` looks for.

### calibration
- `sigma` null, or calibrated in another critic mode: explain in one line ("sigma is how much the critics' scores
  wobble on an unchanged screen; the loop uses it to tell real progress from noise"), say what it costs, and ask
  before running `dl calibrate`. It needs 3 reference screens in `reference/`. In agent mode it exits 10 with a work
  order: dispatch the agents it names, then run it again.

### project
Write `project.json` in the design folder. Every field except `app` is optional:

```json
{
  "app": "Spontai",
  "appRepo": "/Users/me/Projects/What-Now",
  "designDoc": "DESIGN.md",
  "figma": { "fileKey": "…", "targetPageId": "266:2", "componentsPageId": "2012:554" },
  "componentSources": ["figma-library", "gluestack", "makeitanimated", "custom"],
  "codeComponentsDir": "components"
}
```

Ask which component sources the app really has, recommending what you found: a Figma components page →
`figma-library`; `@gluestack-ui/*` in the app's `package.json` → `gluestack`; the `make-it-animated-ai-workflow`
skill installed → `makeitanimated`. `custom` is always allowed.

## Finish

Run `dl check` again and show its output. Done when it reports no failures. Name each remaining warning and
whether it matters for the first run. Then tell the user the next command: `/start-design`.
