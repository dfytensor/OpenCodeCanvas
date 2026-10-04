// OpenCode Canvas 2.0 — shared types (main / preload / renderer)
// Ref: OpenCodeCanvas_2.0_完整设计说明书.md §2 §3 §5

// ───────────────────────── IDs ─────────────────────────

export type NodeID = string // nanoid
export type SessionID = string // opencode session id (ses_...)
export type ProjectID = string

// ───────────────────────── Node state machine (§2.2, append-only) ─────────────────────────

export type NodeStatus =
  | 'draft'
  | 'provisioning'
  | 'running'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'frozen'
  | 'archived'
// ★ no 'deleted': nodes are never deleted (§14)

export type NodeKind = 'root' | 'fork' | 'inherit' | 'merge' | 'ephemeral'

export type TaintLevel = 'none' | 'suspicious' | 'confirmed'

// ───────────────────────── Content projection (§3) ─────────────────────────

export type ContentDimension =
  | 'transcript'
  | 'summary'
  | 'inputs'
  | 'outputs'
  | 'toolTrace'
  | 'diff'
  | 'files'
  | 'artifacts'
  | 'decisions'
  | 'config'

export type ContentView = 'full' | 'compact' | 'digest' | 'patch' | 'files'

export interface NodeRef {
  nodeId: NodeID
  /** pin the projection up to a specific message (with HTTP fork API) */
  atMessage?: string
}

export type RangeSpec =
  | { turns: [number, number] }
  | { last: number }
  | { afterTurn: number }
  | { timeRange: [string, string] }
  | { atMessage: string }

export interface FilterSpec {
  roles?: ('user' | 'assistant')[]
  tools?: string[]
  paths?: string[]
  keywords?: string[]
  excludeSecrets?: boolean
}

export interface Selector {
  from: NodeRef
  take: ContentDimension[]
  range?: RangeSpec
  filter?: FilterSpec
  view?: ContentView
  /** token budget for this single source */
  budgetTokens?: number
}

export type ComposeMode = 'concat' | 'merge' | 'patch-apply' | 'digest-merge'
export type ComposeOrder = 'explicit' | 'topological' | 'chronological'
export type OverflowPolicy = 'escalate-summary' | 'truncate-tail' | 'error'

export interface ComposeSpec {
  mode: ComposeMode
  order: ComposeOrder
  dedupe: boolean
  labelSources: boolean
}

export interface BudgetSpec {
  maxTokens: number
  onOverflow: OverflowPolicy
}

// ───────────────────────── Workspace baseline (§3.5, content-addressed) ─────────────────────────

/**
 * A persisted base reference is ALWAYS content-addressed.
 * Floating references (e.g. "mainline") may exist only during plan resolution,
 * and must be snapshotted + hashed at that instant.
 */
export interface BaseRef {
  kind: 'snapshot' | 'node' | 'commit'
  contentHash: string
  /** human-readable only, e.g. 'mainline@2026-09-04T14:02' — never parsed */
  label: string
  /** materialized snapshot dir for kind='snapshot'/'node' (may be inside .occ) */
  dir?: string
}

export type WorkspaceInheritance = 'MAINLINE' | 'PARENT_STATE' | 'NODE_RESULT' | 'COMPOSED' | 'CLEAN_REPO'

export interface WorkspaceApplyEntry {
  from: NodeID
  paths?: string[]
}

export interface WorkspaceSpec {
  base: BaseRef
  apply: WorkspaceApplyEntry[]
  onConflict: 'agent' | 'ours' | 'theirs' | 'fail'
}

export type InheritChannel = 'fork' | 'import' | 'brief' | 'auto'

export interface InheritPlan {
  /** acceptance verifier runs with tools enabled for functional verification */
  verify?: boolean
  /** pin this plan's workers to a specific provider/model ("pid/mid") */
  providerRef?: string
  sources: Selector[]
  compose: ComposeSpec
  budget: BudgetSpec
  workspace: WorkspaceSpec
  channel: InheritChannel
}

// ───────────────────────── Project (§5) ─────────────────────────

export type AutonomyLevel = 'manual' | 'confirm' | 'autopilot'

export type AgentEngine = 'opencode' | 'native'

export interface ProjectPolicy {
  concurrency: number
  defaultModel?: string
  defaultAgent?: string
  /** node execution engine: opencode server sessions or the built-in agent loop */
  engine: AgentEngine
  /** auto-archive completed/frozen nodes after N days (downgrade storage, never delete) */
  archiveAfterDays: number
  allowPartialSources: boolean
  autonomy: AutonomyLevel
  maxTokensPerNode: number
  /** per-chat cumulative token budget; 0 = unlimited. Over-budget asks for confirmation instead of blocking */
  budgetTokensPerChat: number
  /** sensitive tools (bash/write/edit) ask the user before running; 'auto' runs without asking */
  toolPermission: 'ask' | 'auto'
}

export const DEFAULT_POLICY: ProjectPolicy = {
  concurrency: 4,
  engine: 'opencode',
  archiveAfterDays: 14,
  allowPartialSources: false,
  autonomy: 'confirm',
  maxTokensPerNode: 120_000,
  budgetTokensPerChat: 0,
  toolPermission: 'ask'
}

export interface Project {
  id: ProjectID
  name: string
  rootDir: string
  mainlineNodeId?: NodeID
  orchestratorSessionId?: SessionID
  policy: ProjectPolicy
  createdAt: string
}

// ───────────────────────── Node & graph (§5) ─────────────────────────

export interface NodeTokenUsage {
  input: number
  output: number
  cached: number
}

export interface SessionNode {
  id: NodeID
  projectId: ProjectID
  title: string
  status: NodeStatus
  kind: NodeKind

  /** bound immediately when POST /session or /fork returns — never guessed */
  sessionId?: SessionID
  /** exists only while a TUI view is mounted (on-demand pty) */
  ptyId?: string

  /** generation = topological depth (§9.2 growth axis) */
  gen: number

  // workspace
  workDir?: string // .occ/nodes/<id>/copy
  snapshotDir?: string // .occ/nodes/<id>/snapshot
  baseRef?: BaseRef

  // lineage & inheritance
  parents: NodeID[]
  inheritPlan?: InheritPlan
  channel?: Exclude<InheritChannel, 'auto'>

  // crash-recovery phase (provision/resolve/compose/…/done)
  phase?: string

  /** for chat nodes: the frontier (latest review/worker) of the last pipeline —
   *  the next conversation grows from here instead of restarting */
  frontierId?: NodeID

  // safety (§14.1)
  taint: TaintLevel
  partial?: boolean

  contentManifest?: ContentManifest
  summary?: string
  tokenUsage: NodeTokenUsage
  viewMode: 'headless' | 'tui'

  createdAt: string
  updatedAt: string
  error?: string
}

export interface ContentManifest {
  nodeId: NodeID
  dimensions: Record<
    ContentDimension,
    { available: boolean; approxTokens: number; detail?: string }
  >
  completedAt?: string
  partial: boolean
  tokenUsage?: NodeTokenUsage
}

export interface GraphEdge {
  id: string
  source: NodeID
  target: NodeID
  kind: 'fork' | 'inherit' | 'merge'
  /** e.g. 'diff:src/auth/**' — what was inherited */
  label?: string
}

export interface GraphDoc {
  projectId: ProjectID
  nodes: Record<NodeID, SessionNode>
  edges: GraphEdge[]
  updatedAt: string
}

// ───────────────────────── opencode API DTOs (§3.4) ─────────────────────────

export interface OcSessionDTO {
  id: SessionID
  projectID?: string
  directory?: string
  title?: string
  parentID?: SessionID
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  time?: { created?: number; updated?: number }
}

export interface OcMessageDTO {
  info: {
    id: string
    sessionID: SessionID
    role: 'user' | 'assistant'
    agent?: string
    model?: { providerID?: string; modelID?: string }
    time?: { created?: number; updated?: number }
  }
  parts: Array<{
    id?: string
    type: string
    text?: string
    tool?: string
    state?: { status?: string }
    [key: string]: unknown
  }>
}

export interface OcSessionStatusDTO {
  type?: 'idle' | 'busy' | 'retry' | 'awaiting' // normalized by api.ts
  isPpending?: boolean
  [key: string]: unknown
}

// ───────────────────────── Events (internal bus → renderer) ─────────────────────────

export type OccEvent =
  | { type: 'node.changed'; node: SessionNode }
  | { type: 'edge.added'; edge: GraphEdge }
  | { type: 'node.output'; nodeId: NodeID; chunk: string }
  | { type: 'server.status'; status: 'starting' | 'ready' | 'down' }
  | { type: 'pipeline.chat'; role: 'manager' | 'worker' | 'final'; text: string; nodeId?: NodeID; chatId?: NodeID }

// ───────────────────────── Inherit execution result ─────────────────────────

export interface CreateNodeResult {
  node: SessionNode
  edges: GraphEdge[]
  channel: Exclude<InheritChannel, 'auto'>
  degradedFrom?: InheritChannel
  warnings: string[]
}


// ───────────────────────── Chat nodes (the new primary surface) ─────────────────────────

export interface ChatEntry {
  id: string
  role: 'user' | 'manager' | 'worker' | 'final'
  text: string
  nodeId?: NodeID
  time: string
}

// ───────────────────────── ElectronAPI (renderer bridge) ─────────────────────────

export interface ProjectSummary {
  rootDir: string
  name: string
  nodeCount: number
  runningCount: number
}

export interface OcModelCatalog {
  providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  agents: Array<{ name: string; description?: string; mode?: string }>
}

export interface ElectronAPI {
  dialog: {
    pickDirectory: () => Promise<string | null>
  }
  occ: {
    serverStatus: () => Promise<{ ready: boolean; port?: number; version?: string; managed?: boolean }>
    models: () => Promise<OcModelCatalog>
    updatePolicy: (patch: Partial<ProjectPolicy>) => Promise<Project>
    setEngine: (engine: AgentEngine) => Promise<Project>
    setJevKey: (key: string) => Promise<{ ok: boolean }>
    getLastProject: () => Promise<string | null>
    openProject: (rootDir: string) => Promise<{ project: Project; graph: GraphDoc } | null>
    closeProject: () => Promise<void>
    getGraph: () => Promise<GraphDoc | null>
    createNode: (
      plan: InheritPlan | null,
      opts: { parents: NodeID[]; kind: NodeKind; title?: string; kickoff?: string; channel?: InheritChannel }
    ) => Promise<CreateNodeResult>
    inspectNode: (nodeId: NodeID) => Promise<ContentManifest | null>
    freezeNode: (nodeId: NodeID) => Promise<SessionNode>
    unfreezeNode: (nodeId: NodeID) => Promise<SessionNode>
    archiveNode: (nodeId: NodeID) => Promise<SessionNode>
    sendToNode: (nodeId: NodeID, message: string) => Promise<void>
    abortNode: (nodeId: NodeID) => Promise<void>
    nodeDiff: (nodeId: NodeID) => Promise<string>
    applyNode: (nodeId: NodeID) => Promise<{ ok: boolean; message: string }>
    runPipeline: (opts: {
      parentId: NodeID
      tasks: string[]
      title?: string
      kickoff?: string
      channel?: 'fork' | 'brief'
      timeoutMs?: number
    }) => Promise<{ childIds: NodeID[]; mergeNodeId: NodeID | null; timedOut: boolean }>
    runAdaptive: (opts: { parentId: NodeID; goal: string; maxRounds?: number; channel?: 'fork' | 'brief' }) => Promise<{ started: boolean }>
    onEvent: (cb: (event: OccEvent) => void) => () => void
    // chat nodes
    createChat: () => Promise<string>
    chatSend: (chatId: NodeID, text: string) => Promise<void>
    chatLog: (chatId: NodeID) => Promise<ChatEntry[]>
  }
}