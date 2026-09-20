# Candidate stage: many first generations, specialists pick one

## Problem

`runScreen` takes Stitch's first answer and iterates it. One reading of the screen spec becomes the
whole run. On the `2026-09-20-voice-agent` run that first answer scored 83.0 and both edit rounds made
it worse (79.5, 79.8) before the stopping rule fired — the loop spent $1.06 and three generations
confirming that v00 was the best thing it was ever going to see.

Stitch is cheap and fast relative to the committee, and the spread between two independent readings of
the same spec is far larger than anything three edit rounds recover. The loop should choose what it
iterates rather than accept it.

## What this adds

A candidate stage in front of the existing loop:

1. Generate one screen per **art direction** (a family seed).
2. Ask Stitch for variants of each seed via `generate_variants`.
3. Measure and critique every candidate with the deterministic critic and the full four-specialist
   committee.
4. Select a winner.
5. Copy the winner to `v00` and enter the existing loop unchanged.

Defaults produce six candidates from two families. The loop itself, the stopping rule, the chair and
the report's version timeline are untouched.

## Generation

```
generate_screen_from_text(spec + direction A)                    -> a0
generate_screen_from_text(spec + direction B)                    -> b0
generate_variants(a0, { variantCount: 2, creativeRange, aspects }) -> a1, a2
generate_variants(b0, { variantCount: 2, creativeRange, aspects }) -> b1, b2
```

`generate_variants` is an existing Stitch MCP tool. Its `variantOptions` takes `variantCount` (1–5),
`creativeRange` (`REFINE` | `EXPLORE` | `REIMAGINE`, default `EXPLORE`) and `aspects` (`LAYOUT`,
`COLOR_SCHEME`, `IMAGES`, `TEXT_FONT`, `TEXT_CONTENT`). It requires a seed screen, which is why each
family starts with a text generation.

The adapter's `WHOLE_SCREEN` suffix does not apply here: `generate_variants` returns a full
`design.screens[]` and is not subject to the DOM-patch response mode that afflicts `edit_screens`.

### Art directions

`design/directions.md`, one `## Name` section per direction, the prose beneath it appended to the
first prompt as `Art direction: <prose>`. The first `families` sections are used.

A missing file means one family and no rider, so every existing design folder keeps working and the
default behaviour of a folder that has not opted in is exactly today's behaviour plus variants.

## Selection

Every candidate is measured, critiqued deterministically and scored by all four specialists — the same
`runCommittee` call the loop already makes, with `openIssues: []` since nothing is carried yet.

The winner is the highest composite, **except** that every candidate whose composite is at or above
`leader - sigma` forms a tie group, and within that group the candidate with the fewest open blockers
wins; a further tie falls back to the higher composite, then to the lowest candidate id, so selection
is deterministic. Composite is a weighted mean of critic
opinion; the gate is a count of blockers. Selecting on composite alone can hand the loop a candidate
that reads better and gates worse, and the loop cannot recover blockers the chair never sees.

A candidate whose committee fails entirely is dropped from selection, not fatal, and recorded in
`degradations`. If every candidate loses its committee the run fails as it does today.

**A caveat this stage inherits.** On the `2026-09-21-voice-agent` run every one of the four critics
recorded a hallucination rate of 1.0 — each filed issues citing selectors absent from the measured
document, so `validateEvidence` dropped all of them and the version reported zero open issues. Critic
*scores* are unaffected and composite selection still works, but the blocker tie-break degenerates to
the deterministic issues alone whenever that happens. Selecting between six candidates on a signal
that thin is weaker than it looks, and the tie-break should be read as "fewest deterministic blockers"
until evidence validation is fixed. That fix is out of scope here and is tracked separately.

## Storage

```
runs/<date>-<screen>/
  candidates/
    c0/ … c5/          screen.png, screen.html, digest.json, composite.json,
                       critiques/*.json, prompt.txt, family.txt
    selection.json     rows: id, family, composite, blockers, gatePass, winner
  v00/                 a copy of the winning candidate directory
  v01/ v02/ …          unchanged
  manifest.json        gains `candidates` and `selection`
```

The winner is **copied**, not moved or symlinked. `v00` stays a complete version directory, so
`report`, `approve` and the stop rule need no knowledge of candidates to keep working.

`approve <runDir> <id>` accepts a candidate id as well as a version id, so the committee's pick can be
overruled. Approving a candidate records it in the manifest the same way and writes `approved.json`
into that candidate directory.

## Config

`config.json` gains one block, strict as the rest of the schema:

```json
"candidates": {
  "families": 2,
  "variantsPerFamily": 2,
  "creativeRange": "EXPLORE",
  "aspects": ["LAYOUT", "COLOR_SCHEME"]
}
```

`families` ≥ 1, `variantsPerFamily` 0–5 (Stitch's own cap on `variantCount`; `0` skips the
`generate_variants` call for that family entirely), `creativeRange` and `aspects` constrained to the
enums above. When `directions.md` holds fewer sections than `families`, the extra families are
generated from the bare spec with no rider rather than being an error — two readings of the same
prompt still differ. Omitting the block means `families: 1, variantsPerFamily: 0` — today's behaviour.

The quota guard changes from `maxRounds + 1` to `totalCandidates + maxRounds`, where
`totalCandidates = families * (1 + variantsPerFamily)`. At the defaults that reserves 11 generations
against the 550/month pool rather than 6.

## Code shape

`src/cli/candidates.ts`, new:

- `readDirections(designDir): Promise<string[]>` — parses `directions.md`, `[]` when absent.
- `generateCandidates(...): Promise<Candidate[]>` — the two Stitch calls per family, with the existing
  progress phases so a long generation still shows a heartbeat.
- `pickWinner(rows, sigma): CandidateRow` — the selection rule alone, pure and separately testable.
- `selectCandidate(...): Promise<{ winner: CandidateRow; rows: CandidateRow[] }>` — the whole stage:
  generate, then measure/distill/critique each candidate, then `pickWinner`. Scoring is not a separate
  export; it has no consumer outside this function and a seam with no consumer is a seam to maintain.

`src/cli/run.ts` changes at one call site: `selectCandidate` replaces the `n === 0` branch of the loop,
and the loop starts at `n = 1` with `baseHandle` set to the winner's handle. Its existing
`stitchGenerations` counter takes the candidate count as its starting value.

The winner has already been measured and critiqued, so the stage hands back everything round 0 used to
compute and the loop seeds its state from it rather than re-scoring: `prevDoc` is the winner's
`MeasuredDoc`, `carried` and `prevOpen` its open issues, `records` its `VersionRecord` under `v00`, and
the critic usage it spent is folded into `criticUsage` so the reported spend stays honest. Nothing is
measured or critiqued twice.

`src/store/store.ts` gains `writeCandidate`, `writeSelection` and `promoteCandidate` on `Run`, beside
the existing `writeVersion`, which they share a private directory writer with. `src/report/report.ts` gains a gallery section above the version timeline.

## Testing

- `candidates.test.ts`: family fan-out with a fake generator; directions parsing including the absent
  and malformed file; variant options passed through verbatim; a dropped committee removing a candidate
  without failing the stage; the sigma tie-break preferring fewer blockers; every candidate failing
  being fatal.
- `run.test.ts`: the loop starts from the winner; `stitchGenerations` counts candidates plus edits; the
  quota guard refuses at `totalCandidates + maxRounds`.
- `store.test.ts`: promotion copies rather than moves; a promoted `v00` is byte-identical.
- `report.test.ts`: the gallery renders and marks the winner; `approve` accepts a candidate id.
- An end-to-end check that a design folder with no `candidates` block and no `directions.md` produces
  exactly one generation, as it does today.

## Cost

| | today | with defaults |
| --- | --- | --- |
| Stitch generations | 1 + up to 5 | 6 + up to 5 |
| LLM per run | ~$1.06 | ~$2.30 |
| Wall clock | ~7 min | ~12 min |

## Out of scope

- Carrying more than one candidate into the loop. One winner, one timeline.
- Re-running selection mid-loop.
- Letting the chair see rejected candidates.
