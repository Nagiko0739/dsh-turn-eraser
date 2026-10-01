import { handleRequest } from '../index.js';

// ---- mock 会话 ----
const events = []; let seq = 0;
const add = (type, data, extra = {}) => { const e = { type, seq: seq++, time: 1, data, ...extra }; events.push(e); return e; };
for (const turn of [10, 11, 12]) {
  add('turn/start', { turn });
  add('user/message', { turn, id: `u${turn}`, content: [{ type: 'text', text: `问${turn}` }], source: { kind: 'user' } });
  add('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `答${turn}` }], source: { kind: 'model' } } });
  add('turn/end', { turn });
}
const session = {
  snapshotEvents: () => events,
  surface: { nodes: events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').map((e) => e.seq) },
  append: (type, data, options) => { const e = { type, seq: seq++, time: 2, data, ...options }; events.push(e); return e; },
};
let flushed = 0;
const sessions = { get: () => session, flush: async () => { flushed++; } };
let agentIdle = true;
const agent = {
  session,
  async runMaintenance(job) {
    if (!agentIdle) throw new Error('agent "t" already has active work');
    try { return await job(new AbortController().signal); } finally {}
  },
};
const ctx = { get: (n) => (n === 'sessions' ? sessions : n === 'agents' ? { get: () => agent } : undefined) };

// ---- mock HTTP ----
function mockReq(body, method = 'POST', ctype = 'application/json') {
  const h = {};
  const req = { method, headers: { 'content-type': ctype }, on(ev, fn) { (h[ev] ||= []).push(fn); return req; }, destroy() {} };
  queueMicrotask(() => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    for (const fn of h.data ?? []) fn(buf);
    for (const fn of h.end ?? []) fn();
  });
  return req;
}
function mockRes() {
  const res = { status: 0, body: '' };
  res.writeHead = (st) => { res.status = st; };
  res.end = (t) => { res.body = t ?? ''; };
  return res;
}
async function call(body, opts) {
  const res = mockRes();
  await handleRequest(ctx, mockReq(body, opts?.method, opts?.ctype), res);
  let parsed = null; try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, parsed };
}

console.log('=== HTTP 路径端到端（上一轮漏测的就是这条） ===');
let r = await call({ sessionId: 's1', action: 'hidden' });
console.log(' ① hidden      :', r.status, JSON.stringify(r.parsed?.value ?? r.parsed));
console.log('    →', r.status === 200 && Array.isArray(r.parsed?.value?.turns) ? '✅ 不抛 TDZ 了' : '❌');

r = await call({ sessionId: 's1', action: 'delete', target: { seq: 6 } });
console.log(' ② delete      :', r.status, JSON.stringify(r.parsed?.value ?? r.parsed).slice(0, 90));
console.log('    → 写入墓碑', flushed, '次 flush', flushed === 1 ? '✅' : '❌');

r = await call({ action: 'hidden' });
console.log(' ③ 缺 sessionId:', r.status, r.parsed?.error?.code, r.parsed?.error?.code === 'INVALID_REQUEST' ? '✅' : '❌');

r = await call({ sessionId: 's1', action: 'hidden' }, { method: 'GET' });
console.log(' ④ GET 方法    :', r.status, r.status === 405 ? '✅' : '❌');

r = await call({ sessionId: 's1', action: 'hidden' }, { ctype: 'text/plain' });
console.log(' ⑤ 错误 content:', r.status, r.status === 415 ? '✅' : '❌');

r = await call({ sessionId: 's1', action: 'nope' });
console.log(' ⑥ 未知动作    :', r.status, r.parsed?.error?.code, r.parsed?.error?.code === 'INVALID_REQUEST' ? '✅' : '❌');

r = await call({ sessionId: 's1', action: 'delete', target: { turn: 11 } });
console.log(' ⑧ 按轮次删除  :', r.status, r.parsed?.error?.code ?? JSON.stringify(r.parsed?.value).slice(0, 60));
console.log('    →', r.status === 200 && r.parsed?.value?.turn === 11 ? '✅ 空回那种没有 messageId 的轮次也能删' : '❌');

r = await call({ sessionId: 's1', action: 'delete', target: { turn: 999 } });
console.log(' ⑨ 轮次不存在  :', r.status, r.parsed?.error?.code, r.parsed?.error?.code === 'TARGET_NOT_FOUND' ? '✅' : '❌');

r = await call({ sessionId: 's1', action: 'delete', target: {} });
console.log(' ⑩ 三个都没给  :', r.status, r.parsed?.error?.code, r.parsed?.error?.code === 'INVALID_REQUEST' ? '✅' : '❌');

agentIdle = false;
r = await call({ sessionId: 's1', action: 'delete', target: { seq: 12 } });
console.log(' ⑦ 会话忙      :', r.status, r.parsed?.error?.code, r.parsed?.error?.code === 'AGENT_BUSY' ? '✅（真忙时说忙）' : '❌');
