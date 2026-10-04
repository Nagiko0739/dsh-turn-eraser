/**
 * tests/run-all.mjs —— 一键跑完全部测试。
 *
 * 为什么需要它：README 和 STATUS 都是逐条列命令（`node tests/01-…`、`02-…`……），
 * 8 条里漏跑一条，屏幕上照样一片 ✅。**"容易漏"本身就是一种假验证**。
 * 用这个跑，漏没漏由程序说了算。
 *
 * 用法：`node tests/run-all.mjs`
 * 退出码：全部通过 = 0；任何一个失败 = 1。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs
	.readdirSync(here)
	.filter((name) => /^\d\d-.*\.mjs$/.test(name))
	.sort();

console.log(`=== 跑 ${String(files.length)} 个测试 ===`);
const failed = [];
for (const file of files) {
	const started = Date.now();
	let output = "";
	let code = 0;
	try {
		output = execFileSync(process.execPath, [path.join(here, file)], { encoding: "utf8" });
	} catch (error) {
		code = typeof error.status === "number" ? error.status : 1;
		output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
	}
	const elapsed = `${String(Date.now() - started)}ms`;
	const skipped = output.includes("⏭");
	const mark = code === 0 ? (skipped ? "⏭  跳过（未验证）" : "✅ 通过") : "❌ 失败";
	console.log(`  ${file.padEnd(30)} ${mark.padEnd(14)} ${elapsed}`);
	if (code !== 0) {
		failed.push(file);
		for (const line of output.split("\n").filter((l) => l.includes("❌")).slice(0, 4)) {
			console.log(`      ${line.trim()}`);
		}
	}
}

console.log();
if (failed.length > 0) {
	console.log(`❌ ${String(failed.length)}/${String(files.length)} 个测试失败：${failed.join("、")}`);
	process.exit(1);
}
console.log(`✅ ${String(files.length)} 个测试全部通过`);
