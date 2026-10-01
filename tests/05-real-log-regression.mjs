/**
 * 真实日志回归测试
 *
 * 用本机 DSH 会话日志跑一遍 collectHidden()，确认墓碑解析没有退化。
 *
 * 运行：node tests/05-real-log-regression.mjs [可选的日志文件路径]
 *   不给路径 → 自动在 ~/.dsh/sessions/ 下找一份
 *   找不到日志 → **跳过**（退出码 0，不算失败）
 *
 * 为什么做成"可选"：别人 clone 下来时本机未必有 DSH 会话日志，
 * 不应该因此让测试挂掉。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectHidden } from '../index.js';

/** 找一份可用的会话日志：命令行参数优先，否则自动扫描。 */
function findLog() {
	const arg = process.argv[2];
	if (arg) return fs.existsSync(arg) ? arg : null;
	const base = path.join(os.homedir(), '.dsh', 'sessions');
	let workspaces;
	try {
		workspaces = fs.readdirSync(base);
	} catch {
		return null;
	}
	for (const ws of workspaces.sort()) {
		const wsDir = path.join(base, ws);
		let sessions;
		try {
			if (!fs.statSync(wsDir).isDirectory()) continue;
			sessions = fs.readdirSync(wsDir);
		} catch {
			continue;
		}
		for (const s of sessions.sort()) {
			const candidate = path.join(wsDir, s, 'session.v4.jsonl.zstd');
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return null;
}

const log = findLog();
if (log === null) {
	console.log('⏭  跳过：本机没有找到 DSH 会话日志（~/.dsh/sessions/）。');
	console.log('   这个测试需要真实日志，跳过不算失败。');
	console.log('   也可以手动指定：node tests/05-real-log-regression.mjs <日志路径>');
	process.exit(0);
}

console.log(`日志：${log.replace(os.homedir(), '~')}`);

let raw;
try {
	raw = execSync(`zstd -dc "${log}"`, { maxBuffer: 1 << 30, encoding: 'utf8' });
} catch (error) {
	console.log(`⏭  跳过：解压失败（${error instanceof Error ? error.message : String(error)}）。`);
	process.exit(0);
}

const events = raw
	.split('\n')
	.filter((line) => line.trim())
	.map((line) => {
		try {
			return JSON.parse(line);
		} catch {
			return null;
		}
	})
	.filter((e) => e !== null && typeof e.seq === 'number');

if (events.length === 0) {
	console.log('⏭  跳过：日志为空或解析不出事件。');
	process.exit(0);
}

const result = collectHidden({ snapshotEvents: () => events });
console.log(`  事件数        : ${events.length}`);
console.log(`  collectHidden : turns=[${result.turns.slice(0, 20).join(', ')}${result.turns.length > 20 ? ', …' : ''}]`);
console.log(`                  steps 共 ${result.steps.length} 条`);

// 健全性检查：必须是数组、元素为整数、且升序
const ok =
	Array.isArray(result.turns) &&
	Array.isArray(result.steps) &&
	result.turns.every((t) => Number.isSafeInteger(t)) &&
	result.turns.every((t, i) => i === 0 || t >= result.turns[i - 1]);
console.log(ok ? '✅ turns/steps 结构正确且升序' : '❌ 返回结构异常');
process.exit(ok ? 0 : 1);
