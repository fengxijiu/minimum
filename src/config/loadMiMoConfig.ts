import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { MiMoConfig } from "./MiMoConfig.js";

// Native MiMoConfig files take precedence; opencode.json (written by `init`)
// is read last and translated into MiMoConfig shape.
const CONFIG_PATHS = [
	".mimo/config.json",
	".mimo.json",
	"opencode.json",
];

/**
 * 把 `init` 写出的 opencode.json（{ minimum: { optimization, ... } }）翻译成 MiMoConfig。
 * 这样 `/init` 生成的配置才会真正被 createMiMoStack 读取，而不是被静默忽略。
 */
function fromOpenCode(raw: any): MiMoConfig {
	const min = raw?.minimum;
	if (!min) return raw as MiMoConfig; // already MiMoConfig-shaped
	const opt = min.optimization ?? {};
	const cfg: MiMoConfig = {};
	if (opt.validation !== undefined) cfg.validation = { enabled: !!opt.validation };
	if (opt.completeness !== undefined) cfg.completeness = { enabled: !!opt.completeness };
	if (opt.context) {
		cfg.context = {
			...(opt.context.foldThreshold !== undefined && { foldThreshold: opt.context.foldThreshold }),
			...(opt.context.aggressiveThreshold !== undefined && { aggressiveThreshold: opt.context.aggressiveThreshold }),
		};
	}
	return cfg;
}

function parseConfig(text: string): MiMoConfig {
	const raw = JSON.parse(text);
	return "minimum" in raw ? fromOpenCode(raw) : (raw as MiMoConfig);
}

/**
 * 从项目根目录加载 MiMo 配置文件。
 * 按优先级依次尝试：.mimo/config.json → .mimo.json → opencode.json
 * 找不到或解析失败时静默返回空对象（使用默认值）。
 */
export async function loadMiMoConfig(projectRoot?: string): Promise<MiMoConfig> {
	const root = projectRoot ?? process.cwd();

	for (const rel of CONFIG_PATHS) {
		const abs = path.resolve(root, rel);
		try {
			const text = await fs.readFile(abs, "utf-8");
			return parseConfig(text);
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
			return parseConfig(readFileSync(abs, "utf-8"));
		} catch {
			// ignore
		}
	}

	return {};
}
