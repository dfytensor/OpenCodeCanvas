// Agent Benchmark Suite v2 — 10 tasks, escalating difficulty.
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { execFileSync } from 'child_process'
// Tests: single-file → multi-file → bug-fix → cross-file → algorithm → self-correction
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { getGraph, newSessionNode, upsertNode } from 'F:/OpenCodeCanvas/src/main/graph/store'
import { startAgentSession } from 'F:/OpenCodeCanvas/src/main/agent/session'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface BenchTask {
  id: string
  difficulty: 1 | 2 | 3
  goal: string
  setup?: (p: string) => Promise<void>
  grade: (p: string) => { pass: boolean; detail: string }
}

function nodeEval(projDir: string, code: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('node', ['-e', code], { cwd: projDir, timeout: 15000, encoding: 'utf8', windowsHide: true })
    return { ok: true, out }
  } catch (e: any) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '').slice(0, 200) }
  }
}

const TASKS: BenchTask[] = [
  // D1: simple file creation
  {
    id: 'B1-hello-cmd',
    difficulty: 1,
    goal: '创建 hello.js，运行 node hello.js 输出 "Hello Benchmark"。创建后实际运行验证输出精确匹配。',
    setup: async () => {},
    grade: (p) => {
      if (!existsSync(join(p, 'hello.js'))) return { pass: false, detail: 'missing hello.js' }
      const r = nodeEval(p, `require('./hello.js')`)
      return { pass: r.ok && r.out.includes('Hello Benchmark'), detail: r.out.slice(0, 80) }
    }
  },
  // D1: JSON transform
  {
    id: 'B2-json-pipeline',
    difficulty: 1,
    goal: '读取 input.json（数组 [{name:"a",score:90},{name:"b",score:70},{name:"c",score:85}]），创建 output.json，内容为按 score 降序排列的名字数组 ["a","c","b"]。写回后用 JSON.parse 验证。',
    setup: async (p) => {
      await writeFile(join(p, 'input.json'), '[{"name":"a","score":90},{"name":"b","score":70},{"name":"c","score":85}]')
    },
    grade: (p) => {
      const f = join(p, 'output.json')
      if (!existsSync(f)) return { pass: false, detail: 'missing output.json' }
      try {
        const j = JSON.parse(require('fs').readFileSync(f, 'utf8'))
        return { pass: JSON.stringify(j) === '["a","c","b"]', detail: JSON.stringify(j) }
      } catch (e) { return { pass: false, detail: String(e).slice(0, 80) } }
    }
  },
  // D2: bug fix with test verification
  {
    id: 'B3-fix-fizzbuzz',
    difficulty: 2,
    goal: 'fizzbuzz.js 的 fizzbuzz(15) 应该输出 15 个元素（1 到 15，3 的倍数替换为 "Fizz"，5 的倍数替换为 "Buzz"，两者都是替换为 "FizzBuzz"）但当前实现有 bug。修复它，用 node 运行验证 fizzbuzz(15) 的第 3/5/15 个元素（0-indexed: 2/4/14）分别是 "Fizz"/"Buzz"/"FizzBuzz" 后报告任务完成。',
    setup: async (p) => {
      await writeFile(join(p, 'fizzbuzz.js'), `function fizzbuzz(n) {\n  const r = []\n  for (let i = 1; i <= n; i++) {\n    if (i % 3 === 0) r.push("Fizz")\n    else if (i % 5 === 0) r.push("Buzz")\n    else r.push(String(i))\n  }\n  return r\n}\nmodule.exports = { fizzbuzz }\n`)
    },
    grade: (p) => {
      const r = nodeEval(p, `const {fizzbuzz}=require('./fizzbuzz.js');const x=fizzbuzz(15);console.log(JSON.stringify({len:x.length,e3:x[2],e5:x[4],e15:x[14]}))`)
      return { pass: r.ok && r.out.includes('"e3":"Fizz"') && r.out.includes('"e5":"Buzz"') && r.out.includes('"e15":"FizzBuzz"'), detail: r.out.slice(0, 120) }
    }
  },
  // D2: multi-file coordination
  {
    id: 'B4-multi-file',
    difficulty: 2,
    goal: '创建三个文件：config.js 导出 PORT=3000 和 HOST="localhost"；server.js 导入 config.js 的 PORT 并导出 start() 函数打印 "Server on PORT:"；client.js 导入 config.js 的 HOST 并导出 connect() 返回 "Connected to HOST:"。用 node 验证每个文件可正常导入后报告任务完成。',
    setup: async () => {},
    grade: (p) => {
      const r = nodeEval(p, `const c=require('./config.js');console.log(c.PORT,c.HOST)`)
      return { pass: r.ok && r.out.includes('3000'), detail: r.out.slice(0, 80) }
    }
  },
  // D2: algorithm with edge cases
  {
    id: 'B5-binary-search',
    difficulty: 2,
    goal: '创建 search.js，导出函数 binarySearch(arr, target) 实现二分查找，返回目标索引（未找到返回 -1）。要求处理空数组和单元素数组的边界情况。用 node 运行验证 binarySearch([1,3,5,7,9], 5)===2 且 binarySearch([], 1)===-1 且 binarySearch([42], 42)===0 后报告任务完成。',
    setup: async () => {},
    grade: (p) => {
      const r = nodeEval(p, `const m=require('./search.js');const f=m.binarySearch??m.default??m;console.log(JSON.stringify([f([1,3,5,7,9],5),f([],1),f([42],42),f([1,3,5],4)]))`)
      return { pass: r.out.includes('[2,-1,0,-1]'), detail: r.out.slice(0, 120) }
    }
  },
  // D3: self-correction (write code that must pass its own test)
  {
    id: 'B6-tdd-calculator',
    difficulty: 3,
    goal: '创建 calculator.js，导出 Calculator 类，包含 add(a,b)、subtract(a,b)、multiply(a,b)、divide(a,b) 四个方法。divide 除以 0 时抛出 Error("Division by zero")。创建完后，写一个 test.js 运行所有方法验证结果（包括 divide(1,0) 应该抛错），用 node test.js 运行验证全部通过后报告任务完成。',
    setup: async () => {},
    grade: (p) => {
      const r = nodeEval(p, `const C=require('./calculator.js');const c=new C();const results=[c.add(2,3),c.subtract(5,2),c.multiply(3,4)];try{c.divide(1,0);results.push('no-throw')}catch(e){results.push('threw')};results.push(c.divide(10,2));console.log(JSON.stringify(results))`)
      return { pass: r.ok && r.out.includes('[5,3,12,"threw",5]'), detail: r.out.slice(0, 120) }
    }
  },
  // D3: refactoring with behavior preservation
  {
    id: 'B7-refactor-callback',
    difficulty: 3,
    goal: 'legacy.js 使用回调模式（callback hell）。将其重构为使用 async/await 的现代版本，保存为 modern.js（导出相同功能），保持行为完全一致。用 node 验证 modern.js 的输出与 legacy.js 相同后报告任务完成。',
    setup: async (p) => {
      await writeFile(join(p, 'legacy.js'), `
function fetchData(callback) {
  setTimeout(() => callback(null, { id: 1, name: "test" }), 10)
}
function process data(data, callback) {
  setTimeout(() => callback(null, { ...data, processed: true }), 10)
}
function saveData(data, callback) {
  setTimeout(() => callback(null, { saved: true, data }), 10)
}
module.exports = { fetchData, processData, saveData }
`)
    },
    grade: (p) => {
      return { pass: existsSync(join(p, 'modern.js')), detail: existsSync(join(p, 'modern.js')) ? 'modern.js exists' : 'missing modern.js' }
    }
  },
  // D3: multi-round self-correction (intentionally hard — requires iteration)
  {
    id: 'B8-regex-parser',
    difficulty: 3,
    goal: '创建 parser.js，导出函数 parseCSV(csvString) 解析 CSV 格式字符串（第一行是列名，后续行是数据，逗号分隔，支持双引号包裹的含逗号字段）。返回对象数组。用 node 运行验证 parseCSV("name,age\\nAlice,30\\nBob,25") 返回 [{name:"Alice",age:"30"},{name:"Bob",age:"25"}] 后报告任务完成。',
    setup: async () => {},
    grade: (p) => {
      const r = nodeEval(p, `const m=require('./parser.js');const f=m.parseCSV??m.default??m;const r=f("name,age\\nAlice,30\\nBob,25");console.log(JSON.stringify(r))`)
      return { pass: r.ok && r.out.includes('"Alice"') && r.out.includes('"30"') && r.out.includes('"Bob"') && r.out.includes('"25"'), detail: r.out.slice(0, 150) }
    }
  },
  // D3: cross-file dependency chain
  {
    id: 'B9-dependency-chain',
    difficulty: 3,
    goal: '创建依赖链：logger.js 导出 log(msg)；database.js 导入 logger.js 的 log 并导出 save(data)（调用 log 后返回数据）；api.js 导入 database.js 的 save 和 logger.js 的 log，导出 process(data) 调用 save 后调用 log 返回结果。用 node 验证整条依赖链可正常导入运行后报告任务完成。',
    setup: async () => {},
    grade: (p) => {
      const r = nodeEval(p, `const api=require('./api.js');console.log(JSON.stringify(api.process({id:1})))`)
      return { pass: r.ok && r.out.includes('id'), detail: r.out.slice(0, 100) }
    }
  },
  // D3: error handling + edge cases + integration
  {
    id: 'B10-robust-validator',
    difficulty: 3,
    goal: '创建 validator.js，导出函数 validateUser(user) 验证用户对象：name 必须是非空字符串（≥2 字符），email 必须包含 @，age 必须是正整数。返回 {valid: boolean, errors: string[]}。用至少 4 个测试用例（有效、无效名字、无效邮箱、无效年龄、null 输入）验证后报告任务完成。',
    setup: async () => {},
    grade: (p) => {
      const r = nodeEval(p, `const m=require('./validator.js');const f=m.validateUser??m.default??m;const cases=[f({name:"Alice",email:"a@b.c",age:25}),f({name:"",email:"bad",age:-1}),f(null),f({name:"Bo",email:"b@c.d",age:30})];console.log(JSON.stringify(cases.map(c=>c?c.valid:null)))`)
      return { pass: r.ok && r.out.includes('true') && r.out.includes('false'), detail: r.out.slice(0, 150) }
    }
  }
]

export { TASKS as AGENT_BENCH_TASKS }
