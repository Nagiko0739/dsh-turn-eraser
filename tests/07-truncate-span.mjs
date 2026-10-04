import './_guard.mjs';   // 让打印 ❌ 真的等于测试失败（见该文件头说明）
import { collectHidden } from '../index.js';

const events = [];
let seq = 0;
const add = (type, data) => { events.push({ type, seq: seq++, time: 1, data }); };
// 三轮：10 / 11 / 12
for (const turn of [10, 11, 12]) {
  add('turn/start', { turn });
  add('user/message', { turn, message: { id: `u${turn}`, content: [{ type: 'text', text: 'q' }] } });
  add('assistant/message', { turn, step: 1, message: { id: `a${turn}`, content: [{ type: 'text', text: 'x' }] } });
  add('tool/result', { turn, step: 1, callId: `c${turn}` });
  add('turn/end', { turn });
}
const turn11Start = events.find((e) => e.type === 'user/message' && e.data.turn === 11).seq;
const lastSeq = events[events.length - 1].seq;

// truncate：从 turn 11 起全删。墓碑只有 surfaceOp 区间，**不带 sourceEventSeqs**
add('assistant/message',
  { turn: 11, step: 1, message: { id: 'tomb', content: [], source: { provider: 'session-tools', model: 'tombstone' } } });
events[events.length - 1].surfaceOp = { op: 'replace', startSeq: turn11Start, endSeq: lastSeq };

const r = collectHidden({ snapshotEvents: () => events });
console.log('turns =', JSON.stringify(r.turns), ' 期望 [11,12]');
console.log(JSON.stringify(r.turns) === '[11,12]' ? '✅ 无 sourceEventSeqs 也能算全（靠 surfaceOp 区间）' : '❌ 算漏了');

// 再验：单轮删除（区间只覆盖一轮）
const events2 = events.filter((e) => e.seq < turn11Start || (e.data?.turn === 11 && e.seq <= turn11Start + 2));
const r2 = collectHidden({ snapshotEvents: () => events2 });
console.log('单轮场景 turns =', JSON.stringify(r2.turns));
