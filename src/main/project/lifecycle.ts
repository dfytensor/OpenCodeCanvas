// Project open/bootstrap flow: project record + graph binding + mainline root node.
import type { GraphDoc, Project, SessionNode } from '../../shared/types'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { openProject, saveProject } from './registry'
import { getGraph, newSessionNode, patchNode, saveGraph, upsertNode } from '../graph/store'
import { hashDirFast } from '../workspace/hash'

export async function openProjectWithGraph(
  rootDir: string
): Promise<{ project: Project; graph: GraphDoc }> {
  const project = await openProject(rootDir)
  const graph = await getGraph(rootDir)
  if (!graph.projectId) {
    graph.projectId = project.id
    await saveGraph(rootDir, graph)
  }
  // seed the project-memory file once — every worker/verifier reads it
  try {
    const ctxFile = join(rootDir, '.occ', 'CONTEXT.md')
    if (!existsSync(ctxFile)) {
      await mkdir(join(rootDir, '.occ'), { recursive: true })
      await writeFile(
        ctxFile,
        [
          '# 项目上下文（agent 每次开工前都会读这里）',
          '',
          '<!-- 在下面写下：技术栈、目录结构、代码约定、禁区（不要动的文件/接口）、',
          '     构建/测试命令。删掉本注释，用要点填写。 -->',
          ''
        ].join('\n'),
        'utf8'
      )
    }
    // skills-as-state: capability registry — drop a .md file to teach the agent
    const skillsDir = join(rootDir, '.occ', 'skills')
    if (!existsSync(skillsDir)) {
      await mkdir(skillsDir, { recursive: true })
      await writeFile(
        join(skillsDir, 'README.md'),
        [
          '# 技能注册表（skills-as-state）',
          '',
          '把能力写成 .md 文件放进本目录，agent 开工时会看到索引，需要时读取全文遵循执行。',
          '',
          '文件格式：',
          '  when: 什么情况下使用这个技能（一行，会出现在 agent 的技能索引里）',
          '  ----',
          '  技能的完整指令/流程/脚本……',
          '',
          '示例见 deploy.md.example（重命名为 .md 即生效）。'
        ].join('\n'),
        'utf8'
      )
      await writeFile(
        join(skillsDir, 'deploy.md.example'),
        [
          'when: 用户要求部署、发布或上线本项目时',
          '----',
          '1. 运行 npm run build 确认构建通过',
          '2. 运行测试套件',
          '3. 按项目实际的发布流程执行（在此写下你的真实流程）'
        ].join('\n'),
        'utf8'
      )
    }
  } catch {
    // best-effort — a read-only project root must not block opening
  }
  return { project, graph }
}

/** Long-horizon crash recovery: in a fresh process every running/provisioning/
 *  awaiting node is an orphan (pipelines live in main-process memory). Called
 *  by the ipc layer on FIRST open of a project per boot — never re-open, or it
 *  would kill live pipelines. */
export async function recoverOrphanNodes(rootDir: string): Promise<number> {
  const graph = await getGraph(rootDir)
  let n = 0
  for (const node of Object.values(graph.nodes)) {
    if (node.status === 'running' || node.status === 'provisioning' || node.status === 'awaiting_input') {
      await patchNode(rootDir, node.id, {
        status: 'failed',
        error: 'App 中断恢复：进程重启导致该任务中断——可直接重发目标续跑（前沿继承，不会重做已完成部分）'
      }).catch(() => undefined)
      n++
    }
  }
  if (n > 0) {
    console.error(`[recovery] ${rootDir}: ${n} orphaned node(s) marked failed (restart-interrupted)`)
  }
  return n
}

export async function ensureMainline(
  rootDir: string
): Promise<{ project: Project; rootNode: SessionNode }> {
  const { project, graph } = await openProjectWithGraph(rootDir)
  const existing = project.mainlineNodeId ? graph.nodes[project.mainlineNodeId] : undefined
  if (existing) return { project, rootNode: existing }

  // floating baseRef until hashed — snapshot + hash is backfilled below (§3.5)
  let rootNode = newSessionNode(graph, {
    projectId: project.id,
    title: project.name,
    kind: 'root',
    status: 'completed',
    workDir: rootDir,
    parents: [],
    baseRef: {
      kind: 'snapshot',
      contentHash: 'pending',
      label: `mainline@${new Date().toISOString()}`
    }
  })
  rootNode = await upsertNode(rootDir, rootNode)

  // lazy backfill: hashDirFast skips .occ, so graph writes during hashing are stable
  const contentHash = await hashDirFast(rootDir)
  if (rootNode.baseRef) {
    rootNode = await patchNode(rootDir, rootNode.id, {
      baseRef: { ...rootNode.baseRef, contentHash }
    })
  }

  const updated: Project = { ...project, mainlineNodeId: rootNode.id }
  await saveProject(rootDir, updated)
  return { project: updated, rootNode }
}

// completed/frozen nodes whose updatedAt is older than `days` — candidates only, no side effects
export function staleArchiveCandidates(
  graph: GraphDoc,
  days: number,
  now: number = Date.now()
): SessionNode[] {
  const cutoff = now - days * 86_400_000
  return Object.values(graph.nodes).filter(
    (n) =>
      (n.status === 'completed' || n.status === 'frozen') && Date.parse(n.updatedAt) < cutoff
  )
}
