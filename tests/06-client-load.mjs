import './_guard.mjs';   // 让打印 ❌ 真的等于测试失败（见该文件头说明）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 相对于「本文件」定位，而不是相对于运行目录——否则从不同目录运行就找不到文件。
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
let captured = null;
const win = { __ModuleLoader__: { load: (def) => { captured = def; } } };
new Function('window', src)(win);
console.log('✅ load() id =', captured.id);

const React = {
  createElement: (...a) => ({ a }),
  useEffect(){}, useLayoutEffect(){}, useRef: () => ({current:null}), useState: () => [null, ()=>{}],
};

function run(label, primitivesOrNull) {
  const req = (n) => {
    if (n === 'react') return React;
    if (n === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitivesOrNull === null) throw new Error('Cannot find package');
      return primitivesOrNull;
    }
    throw new Error('Cannot find module ' + n);
  };
  try {
    const mod = captured.factory(req);
    // 顺手跑一次 apply，确认插槽注册路径不抛错
    const registered = [];
    const ctx = {
      locale: { register: () => () => {}, getLocale: () => ({ active: 'zh-CN' }) },
      slots: { inject: (hole) => { registered.push(hole); }, register: (o, c) => ({ o, c }) },
      effect: (fn) => { const r = fn(); return r; },
    };
    mod.apply(ctx);
    console.log(`✅ ${label}: factory + apply 通过，注册插槽 = [${registered.join(', ')}]`);
  } catch (e) {
    console.log(`❌ ${label}: ${e.message}`);
    process.exitCode = 1;
  }
}

run('官方组件库可用', { IconTrashOutline16: () => null, Tooltip: ({children}) => children });
run('官方组件库不可用（自绘兜底）', null);
