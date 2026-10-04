/**
 * tests/_guard.mjs —— 让「打印 ❌」真的等于「测试失败」。
 *
 * 2026-10-04 补的一个真缺陷：01 / 02 / 03 / 04 / 07 这几个测试只往屏幕上打 ❌，
 * 却从不设置退出码。于是 `node tests/xx.mjs && echo 通过` **永远是"通过"**——
 * "跑测试看退出码"这件事在这些文件上完全失效，等于没测。
 *
 * 用法：在测试文件**最顶部**（其它 import 之前）加一行
 *
 *     import './_guard.mjs';
 *
 * 之后任何一行输出里出现 ❌，进程就会以非零码退出。
 *
 * 三条边界（都实测过）：
 *   - 测试自己调 `process.exit(0)` 也拦得住（退出码仍会变成 1）✅
 *   - `console.error` 也一并盯着（2026-10-04 发现只劫持 log 会漏掉走 stderr 的 ❌）✅
 *   - 出现 `⏭ 跳过` 时**不判失败，但会明确提示"这部分没被验证"**——
 *     跳过不等于通过，别让屏幕上的 ✅ 骗人。
 *
 * 反过来：如果某个测试里的 ❌ 是**预期结果**（比如故意触发一个错误），
 * 就把它换成别的标记，别让守卫误判。
 */
let failed = 0;
let skipped = 0;

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

function scan(line) {
	if (line.includes("❌")) failed += 1;
	if (line.includes("⏭")) skipped += 1;
}

const tap = (original) => (...args) => {
	scan(args.map((value) => String(value)).join(" "));
	original(...args);
};

console.log = tap(originalLog);
console.error = tap(originalError);

process.on("exit", (code) => {
	if (failed > 0) {
		originalLog(`\n❌ 本次运行出现 ${failed} 处失败标记 → 退出码置为 1`);
		process.exitCode = 1;
		return;
	}
	// 测试自己已经把退出码设成非零时不再多嘴。
	if (code !== 0) return;
	if (skipped > 0) {
		originalLog(`\n⚠️ 没有失败标记，但有 ${skipped} 处「跳过」——这部分**没有被验证**，别当成通过。`);
		return;
	}
	originalLog("\n✅ 无失败标记，也没有跳过");
});
