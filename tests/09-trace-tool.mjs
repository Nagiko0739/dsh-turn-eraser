import './_guard.mjs';   // 让打印 ❌ 真的等于测试失败（见该文件头说明）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 09 —— tools/trace_deletions.py 的烟雾测试。
 *
 * 为什么值得有：那是**交付给用户的工具**（README 让用户跑它把删掉的原文读回来）。
 * 它坏了不会有任何测试变红，用户只会以为"这个会话没有删除记录"——
 * 又是一次"看起来没事"。2026-10-04 补。
 *
 * 做法：造一份最小假日志（2 轮，第 2 轮带墓碑）→ zstd 压成 DSH 的格式 →
 * 用 DSH_SESSIONS_DIR 指给工具扫 → 检查它能不能把墓碑和被删原文都读出来。
 * 需要 `zstd` 与 `python3`；缺任何一个就跳过（守卫会提示"这部分没有被验证"）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.join(here, '..', 'tools', 'trace_deletions.py');

function has(cmd) {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

if (!has('zstd') || !has('python3')) {
  console.log('⏭  跳过：需要 `zstd` 与 `python3` 才能跑这个烟雾测试。');
  process.exit(0);
}

// ---- 造一份假日志：第 2 轮被删 ----
const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '第一轮的问题' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 2, time: 1, data: { message: { content: [{ type: 'text', text: '第一轮的回答' }] } } },
  { type: 'turn/end', seq: 3, time: 1, data: { turn: 1 } },
  { type: 'turn/start', seq: 4, time: 1, data: { turn: 2 } },
  { type: 'user/message', seq: 5, time: 1, data: { content: [{ type: 'text', text: '被删掉的那句话' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 6, time: 1, data: { message: { content: [{ type: 'text', text: '被删掉的那段回答' }] } } },
  { type: 'turn/end', seq: 7, time: 1, data: { turn: 2 } },
  {
    type: 'user/message',
    seq: 8,
    time: 2,
    data: {
      content: [{ type: 'text', text: '[已删除第 2 轮]' }],
      source: { kind: 'user', producer: 'session-tools', action: 'delete', removed: [5, 6], turn: 2, preview: '被删掉的那句话' },
    },
    surfaceOp: { op: 'replace', startSeq: 5, endSeq: 7 },
    sourceEventSeqs: [5, 6],
  },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trace-'));
try {
  const sessionDir = path.join(tmp, 'ws-fake', 'session-fake-0001');
  fs.mkdirSync(sessionDir, { recursive: true });
  const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd');
  execFileSync('zstd', ['-q', '-f', '-o', logPath], {
    input: `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
  });

  const run = (args) => execFileSync('python3', [tool, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_DIR: tmp },
  });

  const overview = run([]);
  const full = run(['被删掉', '--full']);

  const checks = [
    ['认出这个会话', overview.includes('session-fake-0001')],
    ['数出墓碑条数', /共\s*1\s*条墓碑/.test(overview)],
    ['显示被删预览', overview.includes('被删掉的那句话')],
    ['--full 读回原文', full.includes('被删掉的那段回答')],
    ['关键词筛选生效', !full.includes('第一轮的回答') || full.includes('被删掉')],
  ];

  let bad = 0;
  for (const [label, ok] of checks) {
    if (!ok) bad += 1;
    console.log(`  ${label.padEnd(24)} ${ok ? '✅' : '❌'}`);
  }
  if (bad > 0) {
    console.log('  ---- 工具实际输出（前 12 行）----');
    console.log(overview.split('\n').slice(0, 12).map((l) => `    ${l}`).join('\n'));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
