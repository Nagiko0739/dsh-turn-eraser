import {
  makeToolDefinition, planTurnDeletion, completedTurns, firstSurfaceSeqOfTurn, TOOL_NAME,
} from '../index.js';

function buildSession() {
  const events = [];
  let seq = 0;
  const add = (type, data, extra = {}) => { const e = { type, seq: seq++, time: 1, data, ...extra }; events.push(e); return e; };
  for (const turn of [10, 11, 12]) {
    add('turn/start', { turn });
    add('user/message', { turn, id: `u${turn}`, content: [{ type: 'text', text: `问${turn}` }], source: { kind: 'user' } });
    add('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `答${turn}` }], source: { kind: 'model' } } });
    add('tool/result', { turn, step: 1, callId: `c${turn}` });
    add('turn/end', { turn });
  }
  const nodes = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result').map((e) => e.seq);
  return {
    session: {
      snapshotEvents: () => events,
      surface: { nodes },
      append: (type, data, options) => { const e = { type, seq: seq++, time: 2, data, ...options }; events.push(e); return e; },
    },
  };
}

const { session } = buildSession();
console.log('已完成轮次 =', JSON.stringify(completedTurns(session)), ' 期望 [10,11,12]');
console.log('第11轮起点 seq =', firstSurfaceSeqOfTurn(session, 11));
console.log();
console.log('=== 四种说法的解析 ===');
const cases = [
  ['删掉第 11 轮', { from: 11 }],
  ['删掉最新一轮', { from: 'latest' }],
  ['删掉第 11~12 轮', { from: 11, to: 12 }],
  ['删掉第 11 轮之后的对话', { from: 11, to: 'end' }],
  ['删掉不存在的第 99 轮', { from: 99 }],
  ['什么都不给', {}],
];
for (const [label, args] of cases) {
  try { console.log(`  ${label.padEnd(22)} → ${JSON.stringify(planTurnDeletion(session, args))}`); }
  catch (e) { console.log(`  ${label.padEnd(22)} → ❌ ${e.code}: ${e.message}`); }
}

console.log();
console.log('=== 工具定义结构（对照官方 ToolDefinition） ===');
const ctx = { get: (n) => (n === 'sessions' ? { flush: async () => {} } : undefined) };
const def = makeToolDefinition(ctx);
console.log('  name        =', def.name, def.name === TOOL_NAME ? '✅' : '❌');
console.log('  description =', typeof def.description, def.description.length, '字', typeof def.description === 'string' ? '✅' : '❌');
console.log('  parameters  =', def.parameters?.type, '必填', JSON.stringify(def.parameters?.required), '✅');
console.log('  output      =', def.output?.schema?.type, '/ render:', typeof def.output?.render, (def.output?.schema && typeof def.output.render === 'function') ? '✅' : '❌');
console.log('  execute     =', typeof def.execute, typeof def.execute === 'function' ? '✅' : '❌');
console.log('  render 输出 =', JSON.stringify(def.output.render({}, { turns: [11, 12], queued: false })));
console.log('  render(排队)=', JSON.stringify(def.output.render({}, { turns: [11], queued: true })));
