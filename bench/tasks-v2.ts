// Agent Benchmark v2 — 10 tasks × 2 configs, foreground batch runner.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { getGraph, newSessionNode, upsertNode } from 'F:/OpenCodeCanvas/src/main/graph/store'
import { startAgentSession } from 'F:/OpenCodeCanvas/src/main/agent/session'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function nodeEval(projDir: string, code: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('node', ['-e', code], { cwd: projDir, timeout: 15000, encoding: 'utf8', windowsHide: true })
    return { ok: true, out }
  } catch (e: any) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '').slice(0, 200) }
  }
}

interface BenchTask {
  id: string
  difficulty: number
  goal: string
  setup?: (p: string) => Promise<void>
  grade: (p: string) => { pass: boolean; detail: string }
}

const TASKS: BenchTask[] = [
  { id: 'B1', difficulty: 1, goal: '创建 hello.js，运行 node hello.js 输出 "Hello Benchmark"。创建后实际运行验证。', grade: (p) => { const f = join(p, 'hello.js'); if (!existsSync(f)) return { pass: false, detail: 'missing' }; try { const r = execFileSync('node', [f], { timeout: 10000, encoding: 'utf8' }); return { pass: r.includes('Hello Benchmark'), detail: r } } catch (e: any) { return { pass: false, detail: String(e.stderr || '').slice(0, 80) } } } },
  { id: 'B2', difficulty: 1, goal: '读取 input.json（数组），创建 output.json 为按 score 降序排列的名字数组。验证后报告完成。', setup: async (p: string) => { await writeFile(join(p, 'input.json'), '[{"name":"a","score":90},{"name":"b","score":70},{"name":"c","score":85}]') }, grade: (p) => { const f = join(p, 'output.json'); if (!existsSync(f)) return { pass: false, detail: 'missing' }; try { const j = JSON.parse(readFileSync(f, 'utf8')); return { pass: JSON.stringify(j) === '["a","c","b"]', detail: JSON.stringify(j) } } catch { return { pass: false, detail: 'parse error' } } } },
  { id: 'B3', difficulty: 2, goal: 'fizzbuzz.js 的 fizzbuzz(15) 有 bug：第 15 个元素应该是 "FizzBuzz" 但当前实现没有。修复并验证 fizzbuzz(15)[14]==="FizzBuzz" 和 fizzbuzz(15)[2]==="Fizz" 后报告完成。', setup: async (p: string) => { await writeFile(join(p, 'fizzbuzz.js'), `function fizzbuzz(n) {\n  const r = []\n  for (let i = 1; i <= n; i++) {\n    if (i % 3 === 0) r.push("Fizz")\n    else if (i % 5 === 0) r.push("Buzz")\n    else r.push(String(i))\n  }\n  return r\n}\nmodule.exports = { fizzbuzz }\n`) }, grade: (p) => { try { const x = execFileSync('node', ['-e', `const {fizzbuzz}=require(process.argv[1]+'\\\\fizzbuzz.js'); const r=fizzbuzz(15); console.log(r[2],r[4],r[14])`, process.argv[1] ? '' : ''].filter(Boolean).concat(['-e', `const {fizzbuzz}=require(${JSON.stringify(join(p, 'fizzbuzz.js'))}); const r=fizzbuzz(15); console.log(r[2],r[4],r[14])`]).slice(-1)[0]], { timeout: 10000, encoding: 'utf8' }); return { pass: x.includes('Fizz') && x.includes('Buzz'), detail: x.slice(0, 80) } } catch (e: any) { return { pass: false, detail: String(e.stderr || '').slice(0, 80) } } } },
  { id: 'B4', difficulty: 2, goal: '创建 config.js（导出 PORT=3000, HOST="localhost"）、server.js（导入 config 的 PORT）、client.js（导入 config 的 HOST）。三个文件形成依赖链，用 node -e 验证全部可导入后报告完成。', grade: (p) => { for (const f of ['config.js', 'server.js', 'client.js']) { if (!existsSync(join(p, f))) return { pass: false, detail: `missing ${f}` } } try { execFileSync('node', ['-e', `const c=require(${JSON.stringify(join(p, 'config.js'))}); if(c.PORT!==3000)throw new Error('bad')`], { timeout: 10000 }); return { pass: true, detail: 'all importable' } } catch (e: any) { return { pass: false, detail: String(e.message).slice(0, 80) } } } },
  { id: 'B5', difficulty: 2, goal: '创建 search.js 导出 binarySearch(arr,target) 二分查找（返回索引或 -1）。验证 binarySearch([1,3,5],5)===1 且 binarySearch([],1)===-1 且 binarySearch([42],42)===0 后报告完成。', grade: (p) => { const f = join(p, 'search.js'); if (!existsSync(f)) return { pass: false, detail: 'missing search.js' }; try { const m = require(f); const ok = m.binarySearch([1,3,5,7,9],5)===2 && m.binarySearch([],1)===-1 && m.binarySearch([42],42)===0; return { pass: ok, detail: ok ? 'correct' : 'wrong results' } } catch (e) { return { pass: false, detail: String(e).slice(0, 80) } } } },
  { id: 'B6', difficulty: 3, goal: '创建 Calculator 类导出 add/subtract/multiply/divide 四方法（divide 除 0 抛 Error）。创建后用 node 实际运行验证：add(2,3)=5, divide(1,0) 抛错, divide(10,2)=5，然后报告完成。', grade: (p) => { const f = join(p, 'Calculator.js'); if (!existsSync(f)) return { pass: false, detail: 'missing Calculator.js' }; try { const C = require(f); const c = new C(); if (c.add(2,3) !== 5 || c.divide(10,2) !== 5) return { pass: false, detail: 'wrong results' }; try { c.divide(1,0); return { pass: false, detail: 'no throw on div0' } } catch { return { pass: true, detail: 'all methods work' } } } catch (e) { return { pass: false, detail: String(e).slice(0, 80) } } } },
  { id: 'B7', difficulty: 3, goal: '创建 stack.js 导出 Stack 类：push(v)、pop()（空时返回 null）、peek()、size()。用 node 运行验证 push(1),push(2),pop()=2,peek()=1,size()=1 后报告完成。', grade: (p) => { const f = join(p, 'stack.js'); if (!existsSync(f)) return { pass: false, detail: 'missing stack.js' }; try { const S = require(f); const s = new S(); s.push(1); s.push(2); if (s.pop() !== 2) return { pass: false, detail: 'pop wrong' }; if (s.peek() !== 1) return { pass: false, detail: 'peek wrong' }; if (s.size() !== 1) return { pass: false, detail: 'size wrong' }; return { pass: true, detail: 'all pass' } } catch (e) { return { pass: false, detail: String(e).slice(0, 80) } } } },
  { id: 'B8', difficulty: 3, goal: '创建 debounce.js 导出 debounce(fn, ms)，返回一个防抖后的函数。用 node 运行验证：连续调 3 次，只有最后一次在 ms 后执行。完成后报告。', grade: (p) => { const f = join(p, 'debounce.js'); if (!existsSync(f)) return { pass: false, detail: 'missing debounce.js' }; try { const m = require(f); const calls: number[] = []; const d = m.debounce((v: number) => calls.push(v), 50); d(1); d(2); d(3); setTimeout(() => { if (calls.length !== 1 || calls[0] !== 3) process.exit(1); process.exit(0) }, 100); return { pass: true, detail: 'async check' } } catch (e) { return { pass: false, detail: String(e).slice(0, 80) } } } },
  { id: 'B9', difficulty: 3, goal: '创建 cache.js 导出 LRUCache 类（constructor(capacity)），方法 get(key)（不存在返回 undefined）、put(key,value)，容量满时淘汰最久未使用的。用 node 运行验证 LRU 行为后报告完成。', grade: (p) => { const f = join(p, 'cache.js'); if (!existsSync(f)) return { pass: false, detail: 'missing cache.js' }; try { const { LRUCache } = require(f); const c = new LRUCache(2); c.put('a',1); c.put('b',2); c.get('a'); c.put('c',3); if (c.get('b') !== undefined) return { pass: false, detail: 'b should be evicted' }; if (c.get('a') !== 1 || c.get('c') !== 3) return { pass: false, detail: 'values wrong' }; return { pass: true, detail: 'LRU works' } } catch (e) { return { pass: false, detail: String(e).slice(0, 80) } } } },
  { id: 'B10', difficulty: 3, goal: '创建 validateUser.js 导出 validateUser(user) 验证：name 非空字符串≥2字符、email 含@、age 为正整数。返回 {valid,errors[]}。用至少 4 个用例（含边界）验证后报告完成。', grade: (p) => { const f = join(p, 'validateUser.js'); if (!existsSync(f)) return { pass: false, detail: 'missing validateUser.js' }; try { const m = require(f); const v = m.validateUser ?? m.default ?? m; const good = v({name:'Alice',email:'a@b.c',age:25}); const badName = v({name:'',email:'x@y.z',age:30}); const nullCase = v(null); if (!good.valid || badName.valid || nullCase.valid) return { pass: false, detail: 'validation logic wrong' }; return { pass: true, detail: 'all cases correct' } } catch (e) { return { pass: false, detail: String(e).slice(0, 80) } } } }
]

export { TASKS as AGENT_BENCH_TASKS }
