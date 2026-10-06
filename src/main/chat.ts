// Chat nodes: the primary user surface. Each chat is a graph root; typing a
// goal spawns the adaptive pipeline (workers → review → extend/done) and the
// graph grows to the right of the chat until the task completes.
import { appendFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { nanoid } from './ids'
import type { ChatEntry, NodeID } from '../shared/types'
import { getGraph, newSessionNode, upsertNode, patchNode, transitionNode } from './graph/store'
import { onOccEvent, emitOccEvent } from './graph/events'
import { getActiveProject } from './project/registry'
import { startAdaptivePipeline, budgetPendingFor, resolveBudget } from './inherit/executor'
import { pendingPermFor, resolvePendingPerm } from './agent/session'

const busyChats = new Set<NodeID>()

function chatFile(rootDir: string, chatId: NodeID): string {
  return join(rootDir, '.occ', 'nodes', chatId, 'chat.jsonl')
}

function now(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export async function createChat(rootDir: string): Promise<string> {
  const project = getActiveProject()
  if (!project) throw new Error('no project open')
  const graph = await getGraph(rootDir)
  let node = newSessionNode(graph, {
    id: nanoid(10),
    projectId: project.id,
    title: `chat-${nanoid(4)}`,
    kind: 'root',
    parents: [],
    gen: 0,
    status: 'draft',
    workDir: rootDir
  })
  node = await upsertNode(rootDir, node)
  return node.id
}

async function appendChat(rootDir: string, chatId: NodeID, entry: ChatEntry): Promise<void> {
  try {
    const dir = join(rootDir, '.occ', 'nodes', chatId)
    await mkdir(dir, { recursive: true })
    await appendFile(chatFile(rootDir, chatId), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // best-effort
  }
}

export async function chatLog(rootDir: string, chatId: NodeID): Promise<ChatEntry[]> {
  try {
    const file = chatFile(rootDir, chatId)
    if (!existsSync(file)) return []
    const raw = await readFile(file, 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ChatEntry)
  } catch {
    return []
  }
}

export async function chatSend(rootDir: string, chatId: NodeID, text: string): Promise<void> {
  const graph = await getGraph(rootDir)
  const node = graph.nodes[chatId]
  if (!node) throw new Error(`chat node not found: ${chatId}`)

  // permission ask pending? the next message decides it (allow / allow all / deny)
  if (pendingPermFor(chatId)) {
    await appendChat(rootDir, chatId, { id: nanoid(6), role: 'user', text, time: now() })
    const verdict = resolvePendingPerm(chatId, text)
    // emit (not appendChat): the pipeline wrapper persists this event into the
    // log AND the renderer subscription surfaces it live — appendChat alone
    // would leave the UI blind to the resolution
    emitOccEvent({
      type: 'pipeline.chat',
      role: 'manager',
      text: verdict === 'deny' ? '已拒绝该操作。' : verdict === 'allow_all' ? '已允许，且本聊天对该类操作免问。' : '已允许执行。',
      nodeId: chatId,
      chatId
    })
    // resume the chat visual state once nothing is pending — without this the
    // node stays amber "awaiting input" forever after the last answer
    if (!pendingPermFor(chatId)) {
      await transitionNode(rootDir, chatId, 'running').catch(() => undefined)
    }
    return
  }

  // budget confirmation pending? the next message IS the decision
  if (budgetPendingFor(chatId)) {
    await appendChat(rootDir, chatId, { id: nanoid(6), role: 'user', text, time: now() })
    const cancel = /取消|停止|cancel|stop|不要/i.test(text)
    resolveBudget(chatId, cancel ? 'cancel' : 'continue')
    return
  }

  if (busyChats.has(chatId)) {
    emitOccEvent({
      type: 'pipeline.chat',
      role: 'manager',
      text: 'still working on the previous goal — wait for it to finish (or abort the running nodes).',
      nodeId: chatId,
      chatId
    })
    return
  }

  await appendChat(rootDir, chatId, { id: nanoid(6), role: 'user', text, time: now() })
  busyChats.add(chatId)
  await patchNode(rootDir, chatId, { status: 'running' }).catch(() => undefined)

  // multi-turn semantics: if a previous pipeline already grew this chat's
  // graph, the new goal grows from the recorded FRONTIER node (inheriting the
  // whole prior chain) instead of restarting from the chat root
  const fresh = await getGraph(rootDir)
  const frontier = fresh.nodes[chatId]?.frontierId ?? chatId

  const wrap = (role: 'manager' | 'worker' | 'final', t: string, nodeId?: NodeID): void => {
    void appendChat(rootDir, chatId, { id: nanoid(6), role, text: t, nodeId, time: now() })
  }

  const unsub = onOccEvent((e) => {
    if (e.type !== 'pipeline.chat' || e.chatId !== chatId) return
    wrap(e.role, e.text, e.nodeId)
    if (e.role === 'final') {
      busyChats.delete(chatId)
      void patchNode(rootDir, chatId, { status: 'completed' }).catch(() => undefined)
      unsub()
    }
  })

  startAdaptivePipeline(rootDir, { parentId: frontier, goal: text, chatId })
}

// safety net: if the pipeline dies without emitting final (crash), unbusy on
// any terminal transition of the chat's descendants is complex — expose a
// simple watchdog: chatSend timeout is bounded by pipeline's own deadlines.
export function isChatBusy(chatId: NodeID): boolean {
  return busyChats.has(chatId)
}
