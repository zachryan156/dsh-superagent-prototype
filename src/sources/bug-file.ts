/** Workspace-local bug intake through the existing Source protocol. */
import { z } from 'zod'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import { key, latestAssignment, type Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import type { Context } from '@deepseek-ai/cordis'

const ConfigSchema = z.object({ workspace: z.string().trim().refine(path => path === '' || isAbsolute(path), 'Workspace must be absolute').default(''), bugFile: z.string().min(1).default('bug.md'),
  pollSeconds: z.number().int().min(1).max(3600).default(10), verifyCommand: z.string().default('') }).strict()
export type BugFileConfig = z.infer<typeof ConfigSchema>
const localPolicy = { allowed: [{ id: 'zach', name: 'Zach' }] }
export const bugFileKind: SourceKind<BugFileConfig> = {
  kind: 'bug-file', title: { en: 'Local bugs', zh: 'Local bugs' },
  description: { en: 'One workspace and its bug.md.', zh: 'One workspace and its bug.md.' },
  schema: ConfigSchema, fields: [
    { key: 'workspace', type: 'text', label: { en: 'Workspace root', zh: 'Workspace root' } },
    { key: 'bugFile', type: 'text', label: { en: 'bug.md path', zh: 'bug.md path' } },
    { key: 'verifyCommand', type: 'text', label: { en: 'Candidate verification command', zh: 'Candidate verification command' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 3600, label: { en: 'Poll interval / seconds', zh: 'Poll interval / seconds' } },
  ], health: ['bug-file'],
  scope: ({ meta }, config) => meta.workspace === (config.workspace ? realpathSync(config.workspace) : '')
    ? { listened: true, observed: false } : { listened: false, reason: 'workspace_not_listened' },
  policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string() })).default(localPolicy.allowed) }).strict().transform(() => localPolicy),
    fields: [], explicit: { en: 'Local requests from Zach.', zh: 'Local requests from Zach.' },
    sync: { label: { en: 'Refresh local identity', zh: 'Refresh local identity' }, ready: () => true, run: async () => localPolicy } },
}
export const name = 'dsh-superagent-bug-file'
export const inject = ['orchestrator']
/** Registers the workspace Source for the lifetime of this plugin. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(bugFileKind))
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, bugFileKind), controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) source.report('bug-file', { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (signal.aborted) return
  if (!ctx.configured()) { ctx.report('bug-file', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<BugFileConfig>('bug-file')
    try {
      if (!config) ctx.report('bug-file', health('paused', 'sourceOff'))
      else if (!config.workspace) ctx.report('bug-file', { state: 'paused', detail: 'Configure a workspace root.' })
      else { await pollBugFile(ctx, config, signal); if (!signal.aborted) ctx.report('bug-file', { state: 'ready', detail: '' }) }
    } catch (error) {
      if (!signal.aborted) ctx.report('bug-file', { state: 'error', detail: String(error) })
    }
    await pause((config?.pollSeconds ?? 10) * 1000, signal)
  }
}

const FieldsSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)])
const VerificationSchema = z.object({ verified: z.literal(true), bugId: z.string(), revision: z.number().int().positive(),
  ticketId: z.string(), commit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict()
const RecordSchema = z.object({ localId: z.number().int().positive(), fields: FieldsSchema, at: z.string(),
  revision: z.number().int().positive(), emitted: z.boolean(), status: z.enum(['unresolved', 'resolved', 'deleted']),
  verification: VerificationSchema.optional() }).strict()
const StateSchema = z.object({ version: z.literal(1), workspace: z.string(), bugFile: z.string(), nextId: z.number().int().positive(),
  bugs: z.array(RecordSchema) }).strict().refine(state => new Set(state.bugs.map(bug => bug.localId)).size === state.bugs.length
    && state.bugs.every(bug => bug.localId < state.nextId), 'Invalid local bug IDs')
type BugRecord = z.infer<typeof RecordSchema>
type BugState = z.infer<typeof StateSchema>

function inside(root: string, path: string): void {
  const child = relative(root, path)
  if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('Bug Source path escapes its workspace')
}
function regular(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Bug Source requires a single-link regular file')
}
function paths(config: BugFileConfig) {
  if (!isAbsolute(config.workspace)) throw new Error('Bug Source workspace must be absolute')
  const root = realpathSync(config.workspace), file = resolve(root, config.bugFile)
  inside(root, file)
  if (basename(file) !== 'bug.md') throw new Error('Bug Source file must be named bug.md')
  inside(root, realpathSync(resolve(file, '..')))
  try { regular(file); inside(root, realpathSync(file)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const directory = join(root, '.dsh')
  try { mkdirSync(directory, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Bug Source .dsh must be a local directory')
  const sidecar = join(directory, 'superagent-bugs.json')
  return { root, file, sidecar }
}
function writeAtomic(path: string, text: string, mode = 0o600): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, text, { flag: 'wx', mode })
  try { renameSync(temporary, path) }
  finally { try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
}
const save = (path: string, state: BugState) => writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`)
function load(path: string, root: string, file: string): BugState {
  let text: string
  try { regular(path); text = readFileSync(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, workspace: root, bugFile: file, nextId: 1, bugs: [] }
  }
  const state = StateSchema.parse(JSON.parse(text))
  if (state.workspace !== root || state.bugFile !== file) throw new Error('Bug Source sidecar belongs to another workspace or bug file')
  return state
}
function readBugFile(file: string): string {
  try { return readFileSync(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return '' }
}
interface BugLine { index: number; done: boolean; fields: z.infer<typeof FieldsSchema> }
function lines(text: string): BugLine[] {
  return text.split('\n').flatMap((line, index) => {
    const match = /^\s*- \[([ xX])\]\s+(.+?)\r?$/.exec(line)
    if (!match) {
      if (/^\s*- \[/.test(line)) throw new Error(`Invalid bug line ${index + 1}`)
      return []
    }
    return [{ index, done: match[1]!.toLowerCase() === 'x', fields: FieldsSchema.parse(match[2]!.split('|').map(field => field.trim())) }]
  })
}
const stableId = (root: string, bug: BugRecord) => `bug:${key('workspace', root)}:${bug.localId}`
const sameFields = (a: BugRecord['fields'], b: BugRecord['fields']) => JSON.stringify(a) === JSON.stringify(b)
const sameAnchor = (a: BugRecord['fields'], b: BugRecord['fields']) => a[0] === b[0] && a[1] === b[1] && a[3] === b[3]
function reconcile(state: BugState, current: BugLine[]): Map<BugLine, BugRecord> {
  const matched = new Map<BugLine, BugRecord>(), used = new Set<number>()
  const claim = (line: BugLine, bug: BugRecord) => { matched.set(line, bug); used.add(bug.localId) }
  for (const line of current) {
    const exact = state.bugs.find(bug => bug.status !== 'deleted' && !used.has(bug.localId) && sameFields(bug.fields, line.fields))
    if (exact) claim(line, exact)
  }
  for (const line of current.filter(line => !matched.has(line))) {
    const candidates = state.bugs.filter(bug => bug.status !== 'deleted' && !used.has(bug.localId) && sameAnchor(bug.fields, line.fields))
    if (candidates.length > 1) throw new Error('Ambiguous bug title edit; keep priority, area and date distinct')
    const previous = candidates[0]
    const bug = previous ?? { localId: state.nextId++, fields: line.fields, at: new Date().toISOString(), revision: 1,
      emitted: false, status: 'unresolved' as const }
    if (!previous) state.bugs.push(bug)
    claim(line, bug)
  }
  for (const [line, bug] of matched) {
    if (!sameFields(bug.fields, line.fields) || (!line.done && bug.status === 'resolved')) {
      bug.revision++; bug.emitted = false; bug.at = new Date().toISOString()
      delete bug.verification
    }
    bug.fields = line.fields
    bug.status = line.done ? 'resolved' : 'unresolved'
  }
  for (const bug of state.bugs) if (!used.has(bug.localId)) bug.status = 'deleted'
  return matched
}

async function verify(ctx: SourceContext, config: BugFileConfig, root: string, bug: BugRecord, signal: AbortSignal) {
  const event = trigger(root, bug), thread = `bug-file:${stableId(root, bug)}`
  const tickets = ctx.threads.get(thread)?.subscriptions.flatMap(id => {
    const ticket = ctx.tickets.get(id)
    return ticket && (ticket.origin.triggerIds.includes(event.id) || ticket.origin.triggerId === event.id
      || ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === event.id)) ? [ticket] : []
  }) ?? []
  if (tickets.length !== 1) return
  const ticket = tickets[0]!, assignment = latestAssignment(ticket)
  const ticketFingerprint = JSON.stringify(ticket)
  if (ticket.ended?.by !== 'executor' || !['completed', 'merged'].includes(ticket.ended.outcome)
    || assignment?.report?.state !== 'ready' || ticket.attention || ticket.undelivered.length) return
  if (!config.verifyCommand.trim()) {
    ctx.threads.describe(thread, { facts: { verification: { label: 'Verification', value: 'Configure a candidate verification command before resolving this bug.', problem: true } } })
    return
  }
  if (!ticket.execution || !isAbsolute(ticket.execution.directory)) throw new Error('Bug verification needs the executor candidate directory')
  const directory = realpathSync(ticket.execution.directory)
  if (directory === root) throw new Error('Bug verification requires the executor candidate, not the intake checkout')
  const commands = ctx.commands.withSignal(signal)
  if ((await commands.git(['rev-parse', '--show-toplevel'], directory)).trim() !== directory) throw new Error('Bug candidate must be its own Git worktree')
  const commit = (await commands.git(['rev-parse', '--verify', 'HEAD'], directory)).trim()
  if ((await commands.git(['status', '--porcelain', '--untracked-files=no'], directory)).trim()) throw new Error('Bug candidate has uncommitted changes')
  const result = VerificationSchema.parse(JSON.parse(await commands.run('env', [
    `DSH_SUPERAGENT_BUG_ID=${event.meta.bugId}`, `DSH_SUPERAGENT_BUG_REVISION=${bug.revision}`,
    `DSH_SUPERAGENT_BUG_TICKET=${ticket.id}`, `DSH_SUPERAGENT_BUG_COMMIT=${commit}`, 'sh', '-c', config.verifyCommand,
  ], directory)))
  if (result.bugId !== event.meta.bugId || result.revision !== bug.revision || result.ticketId !== ticket.id || result.commit !== commit) {
    throw new Error('Bug verification receipt does not match the candidate and request')
  }
  if (signal.aborted || ctx.tickets.get(ticket.id)?.updatedAt !== ticket.updatedAt) return
  if ((await commands.git(['rev-parse', '--verify', 'HEAD'], directory)).trim() !== commit
    || (await commands.git(['status', '--porcelain', '--untracked-files=no'], directory)).trim()) throw new Error('Bug candidate changed during verification')
  return { receipt: result, ticketFingerprint }
}
function trigger(root: string, bug: BugRecord): Trigger {
  const id = stableId(root, bug)
  return { id: bug.revision === 1 ? id : `${id}:${bug.revision}`, source: 'bug-file', threads: [{ source: 'bug-file', id }],
    actor: { source: 'bug-file', id: 'zach' }, human: true, addressed: 'direct', at: bug.at, text: bug.fields.join(' | '),
    meta: { bugId: id, localId: bug.localId, workspace: root, revision: bug.revision } }
}

/**
 * Polls only the configured workspace's bug file and local identity sidecar.
 * @param ctx - Existing Source host, including executor Ticket reads and candidate commands.
 * @param config - One workspace, one intake file and an optional trusted candidate verifier.
 * @param signal - Cancels intake and verification before any further trigger or writeback.
 * @returns After this poll and its workspace lock have settled.
 */
export async function pollBugFile(ctx: SourceContext, config: BugFileConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  const { root, file, sidecar } = paths(config)
  const release = await lock(root, { lockfilePath: `${sidecar}.lock`, stale: 120_000 })
  const saveState = (state: BugState) => {
    const checked = paths(config)
    if (checked.root !== root || checked.file !== file) throw new Error('Bug Source workspace changed during polling')
    save(sidecar, state)
  }
  try {
    if (signal.aborted) return
    paths(config)
    const state = load(sidecar, root, file)
    let text = readBugFile(file)
    const current = reconcile(state, lines(text))
    saveState(state)
    for (const [line, bug] of current) {
      if (signal.aborted) return
      if (line.done) continue
      if (!bug.emitted) {
        const result = await ctx.receive(trigger(root, bug))
        if (result === 'filtered') throw new Error('Bug Source rejected its own workspace request')
        bug.emitted = true
        saveState(state)
      }
      if (signal.aborted) return
      ctx.threads.describe(`bug-file:${stableId(root, bug)}`, { label: bug.fields[2] })
      const verification = await verify(ctx, config, root, bug, signal)
      if (signal.aborted) return
      if (!verification) continue
      const checked = paths(config)
      if (checked.root !== root || checked.file !== file || readFileSync(file, 'utf8') !== text) continue
      const updated = text.split('\n')
      updated[line.index] = updated[line.index]!.replace('[ ]', '[x]')
      bug.verification = verification.receipt
      saveState(state)
      if (JSON.stringify(ctx.tickets.get(verification.receipt.ticketId)) !== verification.ticketFingerprint) {
        delete bug.verification
        saveState(state)
        continue
      }
      text = updated.join('\n')
      writeAtomic(file, text, lstatSync(file).mode & 0o777)
      bug.status = 'resolved'
      saveState(state)
      ctx.threads.describe(`bug-file:${stableId(root, bug)}`, { facts: { verification: { label: 'Verified commit', value: verification.receipt.commit } } })
    }
  } finally { await release() }
}
