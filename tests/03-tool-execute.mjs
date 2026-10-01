import { makeToolDefinition } from '../index.js';

function buildSession() {
  const events = []; let seq = 0;
  const add = (type, data, extra = {}) => { const e = { type, seq: seq++, time: 1, data, ...extra }; events.push(e); return e; };
  for (const turn of [10, 11, 12]) {
    add('turn/start', { turn });
    add('user/message', { turn, id: `u${turn}`, content: [{ type: 'text', text: `问${turn}` }], source: { kind: 'user' } });
    add('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `答${turn}` }], source: { kind: 'model' } } });
    add('turn/end', { turn });
  }
  const nodes = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').map((e) => e.seq);
  let appended = 0;
  const session = {
    snapshotEvents: () => events,
    surface: { nodes },
    append: (type, data, options) => { appended++; const e = { type, seq: seq++, time: 2, data, ...options }; events.push(e); return e; },
  };
  return { session, tombstones: () => appended };
}
let flushed = 0;
const ctx = { get: (n) => (n === 'sessions' ? { flush: async () => { flushed++; } } : undefined) };
const def = makeToolDefinition(ctx);

function makeAgent(session, idle) {
  const agent = {
    session, _idle: idle, maintenanceRan: 0,
    async runMaintenance(job) {
      if (!agent._idle) throw new Error(`agent "test" already has active work`);
      agent.maintenanceRan++;
      agent._idle = false;
      try { return await job(new AbortController().signal); } finally { agent._idle = true; }
    },
  };
  return agent;
}

console.log('=== 场景 A：会话空闲（走正规维护锁） ===');
{
  const { session, tombstones } = buildSession();
  const agent = makeAgent(session, true);
  const r = await def.execute({ from: 11 }, { agent });
  console.log('  返回   =', JSON.stringify(r));
  console.log('  墓碑   =', tombstones(), tombstones() === 1 ? '✅' : '❌');
  console.log('  维护锁 =', agent.maintenanceRan, '次', agent.maintenanceRan === 1 ? '✅' : '❌');
  console.log('  flush  =', flushed, '次', flushed === 1 ? '✅' : '❌');
}

console.log();
console.log('=== 场景 B：会话正忙（模型正在跑这一轮、顺手删自己的内容） ===');
{
  const { session, tombstones } = buildSession();
  const agent = makeAgent(session, false);
  const t0 = Date.now();
  const r = await def.execute({ from: 11 }, { agent });
  const waited = Date.now() - t0;
  console.log('  返回   =', JSON.stringify(r));
  console.log('  耗时   =', waited, 'ms', waited < 500 ? '✅（没有卡住/死锁）' : '❌');
  console.log('  墓碑   =', tombstones(), tombstones() === 1 ? '✅（忙也当场删，不再排空队）' : '❌');
  console.log('  queued =', r.queued === false ? 'false ✅（不再谎报排队）' : '❌');
  console.log('  维护锁 =', agent.maintenanceRan, '次（忙时拿不到锁，走的是直接执行）');
}

console.log();
console.log('=== 场景 C：范围 + 末尾 + 越界 ===');
{
  const { session, tombstones } = buildSession();
  const agent = makeAgent(session, true);
  const r = await def.execute({ from: 10, to: 'end' }, { agent });
  console.log('  删 10~末尾 =', JSON.stringify(r), tombstones() === 3 ? '✅ 三条墓碑' : '❌');
  const { session: s2 } = buildSession();
  try { await def.execute({ from: 88 }, { agent: makeAgent(s2, true) }); console.log('  ❌ 越界没报错'); }
  catch (e) { console.log('  越界      =', e.code, '✅'); }
}

console.log();
console.log('=== 场景 D：没有 agent 上下文 ===');
try { await def.execute({ from: 10 }, {}); console.log('  ❌ 没报错'); }
catch (e) { console.log('  ', e.code, '✅'); }
