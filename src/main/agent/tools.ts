// Tools for the native agent loop. Every path is jailed to the node's workDir
// (§ file isolation) — resolve() then prefix-check, no escapes.
import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface Tool {
  def: ToolDef
  run: (args: Record<string, unknown>) => Promise<string>
}

const MAX_TOOL_OUTPUT = 48 * 1024

function jail(workDir: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(workDir, p)
  const root = resolve(workDir)
  if (abs !== root && !abs.startsWith(root + '\\') && !abs.startsWith(root + '/')) {
    throw new Error(`path escapes the workspace: ${p}`)
  }
  return abs
}

function cap(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s
  return s.slice(0, MAX_TOOL_OUTPUT) + `\n[...output truncated at ${MAX_TOOL_OUTPUT} bytes]`
}

function runShell(workDir: string, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const isWin = process.platform === 'win32'
    // PowerShell understands both Unix-ish (ls, cat, rm) and Windows idioms —
    // raw cmd.exe chokes on the Unix habits models bring with them
    const file = isWin ? 'powershell.exe' : '/bin/bash'
    const args = isWin
      ? ['-NoLogo', '-NoProfile', '-Command', command]
      : ['-lc', command]
    const child = spawn(file, args, {
      cwd: workDir,
      windowsHide: true,
      env: { ...process.env }
    })
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already dead
      }
      rejectP(new Error(`command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < MAX_TOOL_OUTPUT * 2) out += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (out.length < MAX_TOOL_OUTPUT * 2) out += d.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      rejectP(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveP(cap(`exit code: ${code}\n${out.trim() || '(no output)'}`))
    })
  })
}

export function buildTools(workDir: string): Tool[] {
  const tools: Tool[] = [
    {
      def: {
        type: 'function',
        function: {
          name: 'bash',
          description:
            'Run a shell command inside the workspace. Use for builds, tests, git, package installs.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'the shell command to run' },
              timeout_ms: { type: 'number', description: 'optional timeout in ms (default 120000)' }
            },
            required: ['command']
          }
        }
      },
      run: async (args) => {
        const command = String(args.command ?? '')
        if (!command.trim()) return 'error: empty command'
        return runShell(workDir, command, Number(args.timeout_ms ?? 120_000))
      }
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a text file from the workspace (UTF-8).',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'workspace-relative path' } },
            required: ['path']
          }
        }
      },
      run: async (args) => {
        const abs = jail(workDir, String(args.path ?? ''))
        const content = await readFile(abs, 'utf8')
        return cap(content)
      }
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Create or overwrite a text file in the workspace (parent dirs auto-created).',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['path', 'content']
          }
        }
      },
      run: async (args) => {
        const abs = jail(workDir, String(args.path ?? ''))
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, String(args.content ?? ''), 'utf8')
        return `wrote ${abs} (${String(args.content ?? '').length} bytes)`
      }
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'edit_file',
          description:
            'Replace the FIRST exact occurrence of old_string with new_string in a workspace file. Fails if old_string is not found.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' }
            },
            required: ['path', 'old_string', 'new_string']
          }
        }
      },
      run: async (args) => {
        const abs = jail(workDir, String(args.path ?? ''))
        const oldString = String(args.old_string ?? '')
        const newString = String(args.new_string ?? '')
        if (!existsSync(abs)) return `error: file not found: ${args.path}`
        const content = await readFile(abs, 'utf8')
        if (!content.includes(oldString)) return 'error: old_string not found in file'
        const updated = content.replace(oldString, newString)
        await writeFile(abs, updated, 'utf8')
        return `edited ${args.path}`
      }
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'list_dir',
          description: 'List entries of a workspace directory (one level).',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'defaults to workspace root' } }
          }
        }
      },
      run: async (args) => {
        const rel = String(args.path ?? '')
        const abs = rel ? jail(workDir, rel) : resolve(workDir)
        const entries = await readdir(abs, { withFileTypes: true })
        return cap(
          entries
            .map((e) => {
              const st = statSync(join(abs, e.name))
              return `${e.isDirectory() ? 'd' : '-'} ${String(st.size).padStart(10)} ${e.name}`
            })
            .join('\n')
        )
      }
    }
  ]
  return tools
}

export function systemPrompt(workDir: string): string {
  return (
    `You are a coding agent working inside the isolated workspace directory: ${workDir}\n` +
    `Use the provided tools to read, edit, and run things. All paths are workspace-relative.\n` +
    `Work step by step, verify your changes (run builds/tests when available), and when the task is done, ` +
    `reply with a concise summary of what you did and the result.`
  )
}
