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
 * 反过来，如果某个测试里的 ❌ 是**预期结果**（比如故意触发一个错误），
 * 就把它换成别的标记（例如 `↯`），别让守卫误判。
 */
let failed = 0;
const original = console.log.bind(console);

console.log = (...args) => {
	const line = args.map((value) => String(value)).join(" ");
	if (line.includes("❌")) failed += 1;
	original(...args);
};

process.on("exit", (code) => {
	if (failed > 0) {
		original(`\n❌ 本次运行出现 ${failed} 处失败标记 → 退出码置为 1`);
		process.exitCode = 1;
		return;
	}
	// 测试自己已经把退出码设成非零时不再多嘴。
	if (code === 0) original("\n✅ 无失败标记");
});
