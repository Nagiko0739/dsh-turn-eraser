import { applyAction } from '../index.js';

function build() {
  const events = []; let seq = 0;
  const add = (type, data) => { const e = { type, seq: seq++, time: 1, data }; events.push(e); return e; };
  for (const turn of [10, 11, 12]) {
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
  ['单轮删除（第 11 轮）', { action: 'delete', turn: 11 }, '[已删除 1 轮]'],
  ['截断（第 11 轮及之后）', { action: 'truncate', turn: 11 }, '[已删除 2 轮]'],
  ['截断（第 10 轮及之后）', { action: 'truncate', turn: 10 }, '[已删除 3 轮]'],
];

console.log('=== 墓碑文案实测（隔壁 D 老师加的改动）===');
for (const [label, request, expect] of cases) {
  const { session, get } = build();
  applyAction(session, request);
  const text = get().data.content[0].text;
  const ok = text === expect;
  console.log(`  ${label.padEnd(24)} → ${text.padEnd(16)} ${ok ? '✅' : `❌ 期望 ${expect}`}`);
  // 顺便确认：文本非空（严格服务商会拒绝空 user 消息）
  if (text.length === 0) console.log('    ❌ 文案为空！');
}
