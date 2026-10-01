// §5 project registry -?one .occ/project.json per project, plus an in-memory active handle
import { promises as fs } from 'fs'
import * as path from 'path'
import { nanoid } from '../ids'
import type { Project, ProjectPolicy } from '../../shared/types'
import { DEFAULT_POLICY } from '../../shared/types'
import { ensureOccDirs } from '../graph/store'

let activeProject: Project | null = null

async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${nanoid(6)}.tmp`
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, file)
}

export async function openProject(rootDir: string): Promise<Project> {
  const paths = await ensureOccDirs(rootDir)
  let project: Project | null = null
  try {
    const raw = await fs.readFile(paths.projectJson, 'utf8')
    project = JSON.parse(raw) as Project
    project.rootDir = rootDir // rebind in case the folder was moved/copied
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (!project) {
    project = {
      id: nanoid(12),
      name: path.basename(rootDir),
      rootDir,
      policy: { ...DEFAULT_POLICY },
      createdAt: new Date().toISOString()
    }
    await writeFileAtomic(paths.projectJson, JSON.stringify(project, null, 2))
  }
  activeProject = project
  return project
}

export function getActiveProject(): Project | null {
  return activeProject
}

export function setActiveProject(p: Project | null): void {
  activeProject = p
}

export async function saveProject(rootDir: string, project: Project): Promise<void> {
  const paths = await ensureOccDirs(rootDir)
  const persisted: Project = { ...project, rootDir }
  await writeFileAtomic(paths.projectJson, JSON.stringify(persisted, null, 2))
  if (activeProject && activeProject.id === project.id) activeProject = persisted
}

export async function updatePolicy(
  rootDir: string,
  patch: Partial<ProjectPolicy>
): Promise<Project> {
  const project =
    activeProject && activeProject.rootDir === rootDir ? activeProject : await openProject(rootDir)
  const updated: Project = { ...project, policy: { ...project.policy, ...patch } }
  await saveProject(rootDir, updated)
  return updated
}
