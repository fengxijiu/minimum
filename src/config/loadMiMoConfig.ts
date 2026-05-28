import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { MiMoConfig } from "./MiMoConfig.js";

const CONFIG_PATHS = [
	".mimo/config.json",
	".mimo.json",
];

/**
 * 从项目根目录加载 MiMo 配置文件。
 * 按优先级依次尝试：.mimo/config.json → .mimo.json
 * 找不到或解析失败时静默返回空对象（使用默认值）。
 */
export async function loadMiMoConfig(projectRoot?: string): Promise<MiMoConfig> {
	const root = projectRoot ?? process.cwd();

	for (const rel of CONFIG_PATHS) {
		const abs = path.resolve(root, rel);
		try {
			const text = await fs.readFile(abs, "utf-8");
			const parsed = JSON.parse(text);
			return parsed as MiMoConfig;
		} catch {
			// file missing or malformed — try next
		}
	}

	return {};
}

/**
 * 同步版本，供 bin 入口等非 async 上下文使用。
 */
export function loadMiMoConfigSync(projectRoot?: string): MiMoConfig {
	const root = projectRoot ?? process.cwd();

	for (const rel of CONFIG_PATHS) {
		const abs = path.resolve(root, rel);
		try {
			const text = readFileSync(abs, "utf-8");
			return JSON.parse(text) as MiMoConfig;
		} catch {
			// ignore
		}
	}

	return {};
}
