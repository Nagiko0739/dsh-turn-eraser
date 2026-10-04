import './_guard.mjs';   // 让打印 ❌ 真的等于测试失败（见该文件头说明）
import { applyAction } from '../index.js';

/** 造一个只有这些轮次的会话。传跳号的数组（如 [10, 12]）可模拟"中间另有空洞"。 */
function build(turns = [10, 11, 12]) {
  const events = []; let seq = 0;
  const add = (type, data) => { const e = { type, seq: seq++, time: 1, data }; events.push(e); return e; };
  for (const turn of turns) {
    add('turn/start', { turn });
    add('user/message', { turn, id: `u${turn}`, content: [{ type: 'text', text: `问${turn}` }], source: { kind: 'user' } });
    add('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `答${turn}` }], source: { kind: 'model' } } });
    add('turn/end', { turn });
  }
  const nodes = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').map((e) => e.seq);
  let captured = null;
  return {
    session: { snapshotEvents: () => events, surface: { nodes },
      append: (type, data, options) => { captured = { type, data, options }; return { seq: seq++ }; } },
    get: () => captured,
  };
}

const cases = [
  ['单轮删除（第 11 轮）', [10, 11, 12], { action: 'delete', turn: 11 }, '[已删除第 11 轮]'],
  ['截断（第 11 轮及之后）', [10, 11, 12], { action: 'truncate', turn: 11 }, '[已删除第 11~12 轮]'],
  ['截断（第 10 轮及之后）', [10, 11, 12], { action: 'truncate', turn: 10 }, '[已删除第 10~12 轮]'],
  // 跳号：被遮蔽的轮次不连号，必须如实列举，不能圈成区间骗模型
  ['跳号（只有第 10、12 轮）', [10, 12], { action: 'truncate', turn: 10 }, '[已删除第 10、12 轮]'],
];

console.log('=== 墓碑文案实测 ===');
let failed = 0;
for (const [label, turns, request, expect] of cases) {
  const { session, get } = build(turns);
  applyAction(session, request);
  const text = get().data.content[0].text;
  const ok = text === expect && text.length > 0;
  if (!ok) failed += 1;
  console.log(`  ${label.padEnd(22)} → ${text.padEnd(18)} ${ok ? '✅' : `❌ 期望 ${expect}`}`);
  // 顺便确认：文本非空（严格服务商会拒绝空 user 消息）
  if (text.length === 0) console.log('    ❌ 文案为空！');
}
process.exit(failed === 0 ? 0 : 1);
