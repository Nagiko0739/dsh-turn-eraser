import './_guard.mjs';   // 让打印 ❌ 真的等于测试失败（见该文件头说明）
import { applyAction } from '../index.js';

const events = [];
let seq = 0;
const add = (type, data, extra = {}) => { events.push({ type, seq: seq++, time: 1, data, ...extra }); };
for (const turn of [10, 11, 12]) {
  add('turn/start', { turn });
  add('user/message', { turn, id: `u${turn}`, content: [{ type: 'text', text: `问题${turn}` }], source: { kind: 'user' } });
  add('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `回答${turn}` }], source: { kind: 'model' } } });
  add('turn/end', { turn });
}
const surfaceNodes = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').map((e) => e.seq);

let captured = null;
const session = {
  snapshotEvents: () => events,
  surface: { nodes: surfaceNodes },
  append: (type, data, options) => { captured = { type, data, options }; return { seq: 9999 }; },
};

const r = applyAction(session, { action: 'delete', messageId: 'u11' });
console.log('append type      =', captured.type);
console.log('sourceEventSeqs  =', JSON.stringify(captured.options.sourceEventSeqs));
console.log('surfaceOp        =', JSON.stringify(captured.options.surfaceOp));
console.log('source           =', JSON.stringify(captured.data.source).slice(0, 200));
console.log('返回             =', JSON.stringify(r));

const shadowed = captured.options.sourceEventSeqs ?? [];
const op = captured.options.surfaceOp;
// 规则 A：assistant/message 不允许带 sourceEventSeqs
console.log(captured.type === 'assistant/message' && shadowed !== undefined
  ? '❌ 规则A：assistant/message 带了 sourceEventSeqs（会抛 SessionFormatError）'
  : '✅ 规则A：不触发"assistant 禁止携带 sourceEventSeqs"');
// 规则 B：replace 必须完整列出区间内每个 surface 节点
const expected = surfaceNodes.filter((s) => s >= op.startSeq && s <= op.endSeq);
const same = JSON.stringify([...shadowed].sort((a, b) => a - b)) === JSON.stringify([...expected].sort((a, b) => a - b));
console.log(same
  ? `✅ 规则B：sourceEventSeqs 恰好覆盖区间内全部 surface 节点 (${JSON.stringify(expected)})`
  : `❌ 规则B：应含 ${JSON.stringify(expected)}，实际 ${JSON.stringify(shadowed)}`);
// 规则 C：成员唯一且都早于墓碑自身
console.log(new Set(shadowed).size === shadowed.length ? '✅ 规则C：无重复成员' : '❌ 规则C：有重复');
console.log(shadowed.every((s) => s < 9999) ? '✅ 规则D：成员都早于墓碑自身' : '❌ 规则D：成员 seq 不小于墓碑');
console.log(captured.data.content?.[0]?.text ? '✅ 规则E：内容非空（占位文本）' : '❌ 规则E：内容为空，严格服务商会 400');
