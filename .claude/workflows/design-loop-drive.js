export const meta = {
  name: 'design-loop-drive',
  description: 'Drive an agent-mode design-loop run: step, dispatch the critics or chair it asks for, repeat until done or a Figma design order',
  whenToUse: 'An agent-mode design-loop run (criticMode "agent") needs stepping. Args: {tool, designDir, runDir} to resume, or {tool, designDir, screen} to start. Stops and returns at a Figma "design" order, which only the session can build.',
  phases: [
    { title: 'Step', detail: 'run `design-loop step` and read the work order it writes' },
    { title: 'Dispatch', detail: 'one design-loop-* subagent per unit of the work order' },
  ],
}

// args: { tool: absolute path of the design-loop checkout, designDir: absolute design folder,
//         runDir?: run to resume, screen?: screen to start (when there is no runDir), maxSteps?: default 30 }
const { tool, designDir } = args ?? {}
if (!tool || !designDir) throw new Error('args needs { tool, designDir } and either runDir or screen')
let runDir = args.runDir ?? null
const maxSteps = args.maxSteps ?? 30
let lastMissing = []

const STEP_SCHEMA = {
  type: 'object',
  required: ['exitCode', 'output'],
  properties: {
    exitCode: { type: 'number' },
    output: { type: 'string', description: 'the command stdout and stderr, last 40 lines' },
    runDir: { type: 'string', description: 'the absolute run directory, from the "Run:" line or the results path' },
    workOrder: {
      type: 'object',
      description: 'the parsed work-order.json named on the "Work order:" line, verbatim; omit when exit code is not 10',
      properties: {
        kind: { type: 'string' },
        version: { type: 'string' },
        designDir: { type: 'string' },
        runDir: { type: 'string' },
        instruction: { type: 'string' },
        units: { type: 'array', items: { type: 'object' } },
      },
    },
    workOrderPath: { type: 'string' },
  },
}

const command = (sub) =>
  `pnpm --dir "${tool}" design-loop --design "${designDir}" ${sub}`

const brief = (order, unit) => [
  `You are dispatched by a design-loop work order. runDir: ${order.runDir}. designDir: ${order.designDir}.`,
  'Paths under vNN/ are relative to runDir; brief.md, tokens.json and screens/ are relative to designDir.',
  `Inputs: ${JSON.stringify(unit.inputs)}`,
  unit.nextIssueId ? `nextIssueId: ${unit.nextIssueId}` : '',
  `Write your answer to exactly one file: ${order.runDir}/${unit.output}. Write nothing else.`,
].filter(Boolean).join('\n')

for (let n = 1; n <= maxSteps; n++) {
  phase('Step')
  const sub = runDir ? `step "${runDir}"` : `run "${args.screen}"`
  const step = await agent(
    `Run this shell command once and report the result. Do not change, retry or fix anything, and write no files.\n\n` +
      `${command(sub)}\n\n` +
      'Report its exit code and output. If the exit code is 10, read the work-order.json the "Work order:" line names ' +
      'and return it verbatim as workOrder, with its path as workOrderPath. Return the "Run:" directory as runDir.',
    { label: `step ${n}`, phase: 'Step', schema: STEP_SCHEMA, effort: 'low', agentType: 'general-purpose' },
  )
  if (!step) throw new Error('the step agent did not answer')
  runDir = step.runDir ?? runDir

  if (step.exitCode === 0) {
    log(`finished after ${n} step(s)`)
    return { status: 'done', runDir, output: step.output }
  }
  if (step.exitCode !== 10 || !step.workOrder) {
    return { status: 'failed', exitCode: step.exitCode, runDir, output: step.output }
  }

  const order = step.workOrder
  if (order.kind === 'design') {
    // No subagent can reach Figma: the session builds the frame, records its id, and runs this workflow again.
    log(`${order.version}: design order — build it in Figma, write screen-id.txt, then re-run with runDir`)
    return { status: 'design', runDir, workOrder: step.workOrderPath, instruction: order.instruction, units: order.units }
  }

  phase('Dispatch')
  log(`${order.version}: ${order.kind}, ${order.units.length} unit(s)`)
  const answered = await parallel(order.units.map((unit) => () =>
    agent(brief(order, unit), { label: `${order.version} ${unit.critic}`, phase: 'Dispatch', agentType: unit.agent })))
  const missing = order.units.filter((_, i) => answered[i] === null).map((u) => `${order.version}/${u.critic}`)
  // A critic that failed keeps its round waiting; never write its inbox file for it. The same unit failing twice
  // is the skill's "stop and tell the user" case: re-dispatching forever only spends.
  const twice = missing.filter((m) => lastMissing.includes(m))
  if (twice.length) return { status: 'stuck', runDir, unanswered: twice }
  if (missing.length) log(`no answer from: ${missing.join(', ')} — the next step will ask for them again`)
  lastMissing = missing
}

return { status: 'max-steps', runDir }
