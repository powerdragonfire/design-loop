---
name: notion-design-sync
description: Use when the user wants their design-loop runs in Notion — "/notion-design-sync", "sync designs to Notion", "put my design runs in Notion", "update the Notion design board". Publishes a one-way, read-only view of a design folder's runs into a Notion database via the Notion MCP server: one row per run, with a write-once briefing page. The design folder stays the system of record; nothing syncs back.
---

# notion-design-sync

You are publishing a **read-only view** of a design folder into the user's Notion workspace. There is one database
row per design-loop run, and each run gets a short briefing page. The design folder is the system of record:
`runs/<run>/` holds every version, score and approval, and `screens/` holds the specs. Notion is a disposable
presentation layer on top of them. Nothing ever syncs back.

This skill reads state, upserts pages and stops. It never runs, steps, approves or edits anything in the design
folder. Only the two sections marked *(Notion binding)* are specific to Notion.

`dl <command>` below means:

```bash
pnpm --dir "${DESIGN_LOOP_HOME:-$HOME/Projects/design-loop}" design-loop --design "<absolute design dir>" <command>
```

## Lane: report vs Notion

- `dl report <runDir>` is the **deep-review lane**: one run's full report, with every critic, issue and screenshot,
  opened at your desk.
- This skill is the **glanceable lane**: every run's current state in one board, readable wherever Notion runs
  (desktop, web, phone).

They work together: after `approve` or a new run, re-run this skill to refresh the board.

Follow these steps **in order**.

---

## Step 0: Parse input

The user's request may contain:

- Nothing: sync every run that has at least one scored version, plus runs waiting on a work order.
- `--screen <name>`: only that screen's runs.
- `--approved`: only runs with an approved version.
- `--rebuild`: rewrite page bodies too. Bodies are normally write-once (see Step 5).

---

## Step 1: Preflight the connection *(Notion binding)*

This skill is **silently optional**. When Notion is not reachable, it prints one clear message and exits cleanly.

1. Check that Notion MCP tools are available, from this session's own tool list only. Look for tool names
   containing `notion`, such as `mcp__notion__*` or `mcp__claude_ai_Notion__*`. Never run `claude mcp list`. If none
   are available, stop and say:
   > Notion MCP isn't connected. Run `claude mcp add --transport http notion https://mcp.notion.com/mcp`, then
   > start a **new session**, run `/mcp` there to log in, and re-run `/notion-design-sync`.
2. Verify the connection with one cheap call, such as a workspace search. On an auth error, tell the user to
   re-authenticate via `/mcp` and stop. Never retry in a loop.
3. Treat "connected but not authenticated" the same way. **Never start the OAuth flow from this skill**, and never
   ask whether to authenticate now. Give the one-line pointer to `/mcp` and stop.

---

## Step 2: Build the sync set (local data only, no external calls yet)

1. Find the design folder: `~/.design-loop/apps.json` (ask which app if there are several), else `design/` in the
   current project.
2. Run `dl runs --json`. It is the only source of run data. Never read or parse run directories yourself, because
   `runs` already resolves which version is best, the open blockers and majors, the approval, the start options
   and the Figma frame links.
3. Read `project.json` if present. Its `app` names the database ("Design Pipeline — <app>"), and its `figma.fileKey`
   confirms the frame links.
4. Select runs per Step 0. Skip `state: "empty"` runs: a run with no version directory has nothing to show.
5. **If the sync set is empty**, say "Nothing to sync. Brief a screen with `/start-design`, then run it with the
   `design-loop` skill" and **stop**. Create nothing and write no state file.
6. Before touching Notion, state how many rows will be created or checked.

---

## Step 3: Load sync state and locate the database *(Notion binding)*

1. Read `<design dir>/.design-loop/notion-sync.json`:
   ```json
   { "database_id": "...", "database_url": "...", "last_sync": "YYYY-MM-DD" }
   ```
2. If it exists, check that the database id still resolves. If the database was deleted, treat this as a first run.
3. **First run:** search for a database named "Design Pipeline — <app>" (or "Design Pipeline" with no
   `project.json`). If none exists, ask the user where to create it (top level or a page they name), then create it
   with exactly these properties:

   | Property | Type | Value, from `dl runs --json` |
   |---|---|---|
   | Name | title | `<title> · <date>`, using the spec's H1 (`title`), else `screen` |
   | Screen | select | `screen`, so the board groups by screen |
   | State | select | `pass` / `converged` / `max-rounds` / `aborted` for a done run (`stopReason`). `waiting: design` / `waiting: critics` / `waiting: chair` for a waiting one |
   | Approved | select | the approved version, or `not yet` |
   | Agrees with committee | checkbox | `approved.agreedWithTop`; unchecked when not approved |
   | Best version | rich text | `best` |
   | Best score | number | the best version's `composite`, one decimal place |
   | Gate | select | `pass` / `fail`, from the best version's `gatePass` |
   | Open blockers | number | the best version's `blockers` |
   | Open majors | number | the best version's `majors` |
   | Versions | number | the count of scored versions |
   | Mode | select | `new`, `improve` (`start.from`) or `missing state` (`start.seed`) |
   | Direction | number | `start.direction`, else 0 |
   | Figma frame | url | `frameUrl` of the approved version, else of the best version; omit when there is none |
   | Date | date | `date` |
   | Key | rich text | `key`: the dedup anchor, never edited by hand |

4. **Existing database with missing properties:** add the missing ones before upserting. Never remove or retype a
   property.
5. Write `<design dir>/.design-loop/notion-sync.json`. It is personal state; never commit it.

---

## Step 4: Upsert database rows

For each run in the sync set:

1. Query the database for a page whose `Key` equals the run's `key`.
2. **No match:** create the page with every property from the Step 3 table, then write its body (Step 5).
3. **Match:** update **properties only**. Properties are the always-current surface: a waiting run finishing, a new
   approval and a new best version all reach Notion through them. Do not touch the page body, because the user may
   have added notes there. `--rebuild` is the only exception.
4. Never delete or archive pages, even for an aborted run. Rows the user added by hand (no `Key`) are invisible to
   this skill.

If the MCP server rate-limits, back off and continue. Report any page that failed instead of retrying forever.

---

## Step 5: Write the briefing page (new pages only)

Build the body **only from `dl runs --json` and the files it names**:

1. **Outcome:** one line, e.g. "Passed on v01 (87.7) and approved v01, matching the committee's pick", or "Waiting
   on the chair for v01".
2. **Versions:** a table of version, score, gate, open blockers and open majors, with a link to each version's
   Figma frame.
3. **The brief:** the first paragraph and the `## Acceptance criteria` bullets from `screens/<screen>.md`. If the
   spec no longer exists, write "Spec removed since this run". **Never reconstruct a spec from memory.**
4. **Where to look:** the local `report` path as plain text (Notion cannot link into the filesystem), and the
   command that opens it: `design-loop report <run dir>`.

Keep it under about 30 blocks; this is a briefing, not the report.

---

## Step 6: Report

```
## Design sync - YYYY-MM-DD

Database: <database_url>
Synced <N> runs: <C> created, <U> updated, <S> unchanged, <F> failed.

| | Run | State | Best | Approved |
|---|---|---|---|---|
| ✚ | 2026-09-30-join-trip | pass | v01 87.7 | v01 |
| ↻ | 2026-09-29-settings | waiting: chair | v00 80.1 | not yet |
```

List each failure with its error and suggest a re-run; the upsert only touches what failed. Update `last_sync`.

On the first run only, remind the user once: the design folder is the source of truth. Edits in Notion never flow
back, and approval only happens through `design-loop approve` (or the `design-loop` skill).

---

## Important rules

1. **One-way, always.** Nothing from Notion flows back into the design folder. The only local file this skill
   writes is `.design-loop/notion-sync.json`.
2. **Idempotent upsert on `Key`.** A re-run creates nothing twice, because matching is on the run directory name
   and never on titles.
3. **Page bodies are write-once.** Only `--rebuild` rewrites them, and it says so before it does.
4. **Never fabricate.** Every value comes from `dl runs --json` or a file it names. A missing spec gets an explicit
   note, not a reconstruction.
5. **Designs stay where they are.** Screenshots, node trees and reports are never uploaded, attached or embedded.
   A row links to its Figma frame, which already has its own access control, and names the local report path.
   Critique text stays in the report too. The board shows counts, not the critics' prose.
6. **Never approve.** An "Approved" value shown in Notion is read from the run, never decided here.

---

## Adapting to another tool

Only Step 1 (connection preflight) and Step 3 (locate or create the container) are Notion-specific. A version for
another destination (Linear, Airtable, a Google Sheet) keeps every other step and rule, upserts on the same `Key`,
and renames the sync-state file.
