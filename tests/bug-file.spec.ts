import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { apply, bugFileKind, pollBugFile } from '../src/sources/bug-file.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { startRuntime } from './fixtures/host.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const line = '- [ ] med | panel | Fix the margin | 2026-11-12\n'
async function workspace(text = line) {
  const root = mkdtempSync(join(tmpdir(), 'bug-file-'))
  roots.push(root)
  writeFileSync(join(root, 'bug.md'), text)
  const config = bugFileKind.schema.parse({ workspace: root })
  const settings = SettingsSchema.parse({ sources: { 'bug-file': { config } }, eval: { mode: 'off' } })
  const sources = new SourceRegistry(() => settings)
  sources.register(bugFileKind)
  settings.policy.sources['bug-file'] = { ...await bugFileKind.policy!.sync!.run({ sources, context: () => ctx }, { allowed: [] }, new AbortController().signal), admission: {} }
  const repo = new MemoryRepositories(), received: Trigger[] = []
  const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'fix', directory: join(root, 'candidate'), assignment: 'Fix the margin' } }),
    assessor: { request: () => {} }, executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const ctx: SourceContext = {
    deployment: testDeployment(), commands: new Commands(() => testDeployment(), {}, new AbortController().signal),
    ready: Promise.resolve(), configured: () => true, config: () => config as never,
    receive: trigger => { received.push(trigger); const result = engine.receive(trigger); engine.evaluateDue(); return result },
    atomic: work => work(), state: { get: () => undefined, set: () => {}, keys: () => [] },
    threads: { get: repo.threads.get, subscribed: () => repo.threads.list(), describe: () => {}, patch: () => {} },
    tickets: { get: repo.tickets.get, open: repo.tickets.open, bindThread: () => {}, threadClosed: () => {} },
    triggers: { get: repo.triggers.get, latest: thread => received.filter(trigger => `bug-file:${trigger.threads[0]!.id}` === thread).at(-1) },
    notify: () => {}, report: () => {},
  }
  return { root, config, ctx, repo, received, engine, poll: () => pollBugFile(ctx, config, new AbortController().signal) }
}

it('routes identical local lines in two workspaces as distinct explicit human requests', async () => {
  const a = await workspace(), b = await workspace()
  await a.poll()
  expect(a.received).toHaveLength(1)
  expect(b.received).toEqual([])
  expect(existsSync(join(b.root, '.dsh'))).toBe(false)
  await b.poll()
  const first = a.received[0]!, second = b.received[0]!
  expect(first.id).toMatch(/^bug:[a-f0-9]{32}:1$/)
  expect(second.id).toMatch(/^bug:[a-f0-9]{32}:1$/)
  expect(first.id).not.toBe(second.id)
  expect(a.repo.threads.list()[0]!.evaluating?.strength).toBe('explicit')
  expect({ actor: first.actor, human: first.human, addressed: first.addressed, text: first.text,
    stableId: first.meta.bugId === first.id, localId: first.meta.localId }).toMatchInlineSnapshot(`
    {
      "actor": {
        "id": "zach",
        "source": "bug-file",
      },
      "addressed": "direct",
      "human": true,
      "localId": 1,
      "stableId": true,
      "text": "med | panel | Fix the margin | 2026-11-12",
    }
  `)
  expect(readFileSync(join(a.root, 'bug.md'), 'utf8')).toBe(line)
  expect(readFileSync(join(b.root, 'bug.md'), 'utf8')).toBe(line)
})

function commit(directory: string) {
  execFileSync('git', ['add', '.'], { cwd: directory })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
    'commit', '--quiet', '-m', 'candidate'], { cwd: directory })
}
const verifier = `const fs = require('node:fs');
if (!fs.existsSync('fixed.txt')) process.exit(1);
const e = process.env;
console.log(JSON.stringify({ verified: true, bugId: e.DSH_SUPERAGENT_BUG_ID, revision: Number(e.DSH_SUPERAGENT_BUG_REVISION),
ticketId: e.DSH_SUPERAGENT_BUG_TICKET, commit: e.DSH_SUPERAGENT_BUG_COMMIT }));
`
function candidate(root: string) {
  const directory = join(root, 'candidate')
  mkdirSync(directory)
  execFileSync('git', ['init', '--quiet', directory])
  writeFileSync(join(directory, 'verify.cjs'), verifier)
  commit(directory)
  return directory
}
function accept(h: Awaited<ReturnType<typeof workspace>>) {
  const decision = h.engine.decide(h.received[0]!.id, { kind: 'accept', title: 'Fix the margin', scope: 'panel margin', reason: 'Requested' })
  const ticket = h.repo.tickets.get(decision.ticketId!)!
  h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  return ticket.id
}

it('checks the executor candidate before writeback; ready, a PR, a merge, and passing intake code are insufficient', async () => {
  const h = await workspace(), stages: string[] = []
  const other = await workspace()
  await other.poll()
  const otherSidecar = readFileSync(join(other.root, '.dsh/superagent-bugs.json'), 'utf8')
  const directory = candidate(h.root)
  writeFileSync(join(h.root, 'fixed.txt'), 'The intake checkout already passes')
  await h.poll()
  const ticket = accept(h)
  h.engine.bindThread(ticket, { source: 'github', id: '7' }, true)
  h.engine.report(ticket, { state: 'ready', summary: 'PR #7 exists' })
  await h.poll()
  stages.push(readFileSync(join(h.root, 'bug.md'), 'utf8'))
  h.engine.threadClosed({ source: 'github', id: '7' }, 'merged', new Date().toISOString())
  await h.poll()
  stages.push(readFileSync(join(h.root, 'bug.md'), 'utf8'))
  h.config.verifyCommand = 'node verify.cjs'
  await expect(h.poll()).rejects.toThrow()
  stages.push(readFileSync(join(h.root, 'bug.md'), 'utf8'))
  writeFileSync(join(directory, 'fixed.txt'), 'Verified candidate fix')
  commit(directory)
  await h.poll()
  stages.push(readFileSync(join(h.root, 'bug.md'), 'utf8'))
  expect(stages).toEqual([line, line, line, line.replace('[ ]', '[x]')])
  expect(stages.map(text => text.slice(0, 5))).toMatchInlineSnapshot(`
    [
      "- [ ]",
      "- [ ]",
      "- [ ]",
      "- [x]",
    ]
  `)
  const state = JSON.parse(readFileSync(join(h.root, '.dsh/superagent-bugs.json'), 'utf8'))
  expect(state.bugs[0]).toMatchObject({ status: 'resolved', verification: { verified: true, ticketId: ticket, revision: 1 } })
  expect(state.bugs[0].verification.commit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim())
  expect(readFileSync(join(other.root, 'bug.md'), 'utf8')).toBe(line)
  expect(readFileSync(join(other.root, '.dsh/superagent-bugs.json'), 'utf8')).toBe(otherSidecar)
})

it('deduplicates polls and restarts, keeps title edits on one work item, and records deletion', async () => {
  const h = await workspace()
  await h.poll()
  const first = h.received[0]!
  const ticket = accept(h)
  await h.poll()
  await pollBugFile({ ...h.ctx }, { ...h.config }, new AbortController().signal)
  expect(h.received).toHaveLength(1)
  writeFileSync(join(h.root, 'bug.md'), line.replace('Fix the margin', 'Fix the panel margin'))
  await h.poll()
  expect(h.received).toHaveLength(2)
  expect(h.received[1]!.meta.bugId).toBe(first.id)
  expect(h.received[1]!.threads).toEqual(first.threads)
  expect(h.received[1]!.text).toBe('med | panel | Fix the panel margin | 2026-11-12')
  expect(h.repo.tickets.list()).toHaveLength(1)
  expect(h.repo.tickets.get(ticket)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === h.received[1]!.id)).toBe(true)
  await h.poll()
  expect(h.received).toHaveLength(2)
  writeFileSync(join(h.root, 'bug.md'), '')
  await h.poll()
  expect(h.received).toHaveLength(2)
  expect(JSON.parse(readFileSync(join(h.root, '.dsh/superagent-bugs.json'), 'utf8')).bugs).toMatchObject([
    { localId: 1, status: 'deleted' },
  ])
})

it('records a missing bug file as deletion without recreating it or re-emitting requests', async () => {
  const h = await workspace()
  await h.poll()
  unlinkSync(join(h.root, 'bug.md'))
  await h.poll()
  expect(h.received).toHaveLength(1)
  expect(existsSync(join(h.root, 'bug.md'))).toBe(false)
  expect(JSON.parse(readFileSync(join(h.root, '.dsh/superagent-bugs.json'), 'utf8')).bugs[0].status).toBe('deleted')
})

it('uses canonical workspace identity and rejects foreign bug files, directories and sidecar links', async () => {
  const a = await workspace(), b = await workspace()
  const alias = join(b.root, 'alias')
  symlinkSync(a.root, alias)
  await a.poll()
  await pollBugFile(a.ctx, { ...a.config, workspace: alias }, new AbortController().signal)
  expect(a.received).toHaveLength(1)
  await expect(pollBugFile(a.ctx, { ...a.config, bugFile: join(b.root, 'bug.md') }, new AbortController().signal)).rejects.toThrow('escapes')
  const foreign = readFileSync(join(b.root, 'bug.md'), 'utf8')
  unlinkSync(join(a.root, 'bug.md'))
  symlinkSync(join(b.root, 'bug.md'), join(a.root, 'bug.md'))
  await expect(a.poll()).rejects.toThrow('regular file')
  unlinkSync(join(a.root, 'bug.md'))
  writeFileSync(join(a.root, 'bug.md'), line)
  rmSync(join(a.root, '.dsh'), { recursive: true })
  mkdirSync(join(b.root, '.dsh'))
  writeFileSync(join(b.root, '.dsh/superagent-bugs.json'), '{foreign}')
  symlinkSync(join(b.root, '.dsh'), join(a.root, '.dsh'))
  await expect(a.poll()).rejects.toThrow('local directory')
  unlinkSync(join(a.root, '.dsh'))
  mkdirSync(join(a.root, '.dsh'))
  symlinkSync(join(b.root, '.dsh/superagent-bugs.json'), join(a.root, '.dsh/superagent-bugs.json'))
  await expect(a.poll()).rejects.toThrow('regular file')
  expect(readFileSync(join(b.root, 'bug.md'), 'utf8')).toBe(foreign)
  expect(readFileSync(join(b.root, '.dsh/superagent-bugs.json'), 'utf8')).toBe('{foreign}')
})

it('polls high-severity intake through the plugin lifecycle and awaits disposal', async () => {
  const h = await workspace('- [ ] high | panel | Fix the margin | 2026-11-12\n'), disposers: (() => unknown)[] = []
  const registry = new SourceRegistry(() => SettingsSchema.parse({}))
  apply({ orchestrator: { sources: registry, context: () => h.ctx },
    effect: (work: () => () => unknown) => { disposers.push(work()) } } as never)
  try {
    expect(registry.kind('bug-file')).toBe(bugFileKind)
    await vi.waitFor(() => expect(h.received).toHaveLength(1))
    expect(h.received[0]!.text).toBe('high | panel | Fix the margin | 2026-11-12')
  } finally { for (const dispose of disposers.reverse()) await dispose() }
  expect(registry.kind('bug-file')).toBeUndefined()
})

it('stops before another intake when cancellation arrives during receive', async () => {
  const h = await workspace(line + line.replace('Fix the margin', 'Fix the padding'))
  const controller = new AbortController()
  const ctx = { ...h.ctx, receive: async (trigger: Trigger) => { const result = await h.ctx.receive(trigger); controller.abort(); return result } }
  await pollBugFile(ctx, h.config, controller.signal)
  expect(h.received).toHaveLength(1)
  await h.poll()
  expect(h.received).toHaveLength(2)
})

it('automatically installs the local requester policy and routes low-severity intake to the existing executor', async () => {
  const h = await workspace('- [ ] low | panel | Fix the margin | 2026-11-12\n'), host = await startRuntime(), disposers: (() => unknown)[] = []
  try {
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, 'bug-file': { enabled: true, config: h.config } } })
    apply({ orchestrator: host.runtime, effect: (work: () => () => unknown) => { disposers.push(work()) } } as never)
    await vi.waitFor(() => expect(host.candidates()).toHaveLength(1))
    const id = host.candidates()[0]!
    const result = await host.route({ kind: 'accept', trigger_id: id, title: 'Fix the margin', worktree_name: 'local-fix',
      acknowledgement: 'Fix the panel margin.' })
    await host.runtime.idle()
    const ticketId = (result.ticket as { ticket_id: string }).ticket_id
    const ticket = host.runtime.store.tickets.get(ticketId)!
    expect(ticket.mandate.strength).toBe('explicit')
    expect(host.runtime.store.triggers.get(ticket.origin.triggerId)!.text).toBe('low | panel | Fix the margin | 2026-11-12')
    expect(host.agents.has(`worker-${ticketId}`)).toBe(true)
    expect(bugFileKind.policy!.fields).toEqual([])
    expect(bugFileKind.policy!.rows).toBeUndefined()
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await host.stop()
  }
})

it('does not overwrite a title changed while the candidate verifier is running', async () => {
  const h = await workspace(), directory = candidate(h.root)
  writeFileSync(join(directory, 'fixed.txt'), 'Fixed')
  writeFileSync(join(directory, 'verify.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(join(h.root, 'bug.md'))}, ${JSON.stringify(line.replace('Fix the margin', 'Fix a different margin'))});\n${verifier}`)
  commit(directory)
  h.config.verifyCommand = 'node verify.cjs'
  await h.poll()
  const ticket = accept(h)
  h.engine.report(ticket, { state: 'ready', summary: 'Completed' })
  await h.poll()
  expect(readFileSync(join(h.root, 'bug.md'), 'utf8')).toBe(line.replace('Fix the margin', 'Fix a different margin'))
  await h.poll()
  expect(h.received.at(-1)!.meta.bugId).toBe(h.received[0]!.id)
  expect(h.repo.tickets.get(ticket)!.ended).toBeUndefined()
})

it('rejects a successful command with a receipt for a different request', async () => {
  const h = await workspace(), directory = candidate(h.root)
  writeFileSync(join(directory, 'fixed.txt'), 'Fixed')
  writeFileSync(join(directory, 'verify.cjs'), verifier.replace('ticketId: e.DSH_SUPERAGENT_BUG_TICKET', "ticketId: 'other-ticket'"))
  commit(directory)
  h.config.verifyCommand = 'node verify.cjs'
  await h.poll()
  h.engine.report(accept(h), { state: 'ready', summary: 'Completed' })
  await expect(h.poll()).rejects.toThrow('does not match')
  expect(readFileSync(join(h.root, 'bug.md'), 'utf8')).toBe(line)
})

it('retries the same persisted trigger after interruption without creating another Ticket', async () => {
  const h = await workspace()
  const ctx = { ...h.ctx, receive: async (trigger: Trigger) => { h.ctx.receive(trigger); throw new Error('interrupted after store') } }
  await expect(pollBugFile(ctx, h.config, new AbortController().signal)).rejects.toThrow('interrupted after store')
  const ticket = accept(h)
  await h.poll()
  expect(h.received).toHaveLength(2)
  expect(h.received[1]).toEqual(h.received[0])
  expect(h.repo.tickets.list().map(item => item.id)).toEqual([ticket])
})

it('fails without overwriting malformed state or ambiguously edited identities', async () => {
  const h = await workspace(line + line.replace('Fix the margin', 'Fix the padding'))
  await h.poll()
  const sidecar = join(h.root, '.dsh/superagent-bugs.json'), before = readFileSync(sidecar, 'utf8')
  writeFileSync(join(h.root, 'bug.md'), line.replace('Fix the margin', 'Fix the border'))
  await expect(h.poll()).rejects.toThrow('Ambiguous bug title edit; keep severity, area and date distinct')
  expect(readFileSync(sidecar, 'utf8')).toBe(before)
  writeFileSync(sidecar, '{broken')
  await expect(h.poll()).rejects.toThrow()
  expect(readFileSync(sidecar, 'utf8')).toBe('{broken')
})

it('does not resolve a Ticket resumed during the final candidate Git checks', async () => {
  const h = await workspace(), directory = candidate(h.root)
  writeFileSync(join(directory, 'fixed.txt'), 'Fixed')
  commit(directory)
  h.config.verifyCommand = 'node verify.cjs'
  await h.poll()
  const ticket = accept(h)
  h.engine.report(ticket, { state: 'ready', summary: 'Completed' })
  const git = Commands.prototype.git
  let statusReads = 0
  const command = vi.spyOn(Commands.prototype, 'git').mockImplementation(async function(this: Commands, args: string[], cwd: string) {
    const result = await git.call(this, args, cwd)
    if (args[0] === 'status' && ++statusReads === 2) {
      h.engine.receive({ ...h.received[0]!, id: 'followup-during-final-git', text: 'More work remains', at: new Date().toISOString() })
    }
    return result
  })
  try {
    await h.poll()
    expect(statusReads).toBe(2)
    expect(h.repo.tickets.get(ticket)!.ended).toBeUndefined()
    expect(readFileSync(join(h.root, 'bug.md'), 'utf8')).toBe(line)
    expect(JSON.parse(readFileSync(join(h.root, '.dsh/superagent-bugs.json'), 'utf8')).bugs[0].verification).toBeUndefined()
  } finally { command.mockRestore() }
})
