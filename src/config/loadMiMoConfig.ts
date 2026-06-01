import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MiMoConfig } from "./MiMoConfig.js";

function resolveHome(): string {
	return process.env.HOME ?? os.homedir() ?? "~";
}

/** `~/.minimum/config.json` — 全局默认配置，每次调用重新解析 HOME。 */
export function getGlobalConfigPath(): string {
	return path.join(resolveHome(), ".minimum", "config.json");
}

/** 项目级配置路径（`/init` 写入，`loadMiMoConfig` 读取）。 */
export const PROJECT_CONFIG_PATH = ".minimum/config.json";

async function tryRead(absPath: string): Promise<MiMoConfig | null> {
	try {
		return JSON.parse(await fs.readFile(absPath, "utf-8")) as MiMoConfig;
	} catch {
		return null;
	}
}

function tryReadSync(absPath: string): MiMoConfig | null {
	try {
		return JSON.parse(readFileSync(absPath, "utf-8")) as MiMoConfig;
	} catch {
		return null;
	}
}

/** 项目配置覆盖全局；空字符串 / null / undefined 不覆盖。 */
function mergeProjectOverGlobal(
	project: MiMoConfig,
	global: MiMoConfig,
): MiMoConfig {
	const out: MiMoConfig = { ...global };
	for (const k of Object.keys(project) as Array<keyof MiMoConfig>) {
		const v = project[k];
		if (v === undefined || v === null || v === "") continue;
		(out as any)[k] = v;
	}
	if (project.context) out.context = { ...global.context, ...project.context };
	if (project.capacity) out.capacity = { ...global.capacity, ...project.capacity };
	if (project.validation) {
		out.validation = { ...global.validation, ...project.validation };
	}
	if (project.memory) {
		const gm = global.memory ?? {};
		const pm = project.memory;
		out.memory = {
			...gm,
			...pm,
			...(pm.injection ? { injection: { ...gm.injection, ...pm.injection } } : {}),
			...(pm.writeback ? { writeback: { ...gm.writeback, ...pm.writeback } } : {}),
			...(pm.compaction ? { compaction: { ...gm.compaction, ...pm.compaction } } : {}),
		};
	}
	return out;
}

/**
 * 加载配置：项目级（`.minimum/config.json`）优先，回退到全局（`~/.minimum/config.json`）。
 * 两个文件均为原生 MiMoConfig JSON，无格式翻译。
 */
export async function loadMiMoConfig(
	projectRoot?: string,
): Promise<MiMoConfig> {
	const root = projectRoot ?? process.cwd();
	const global = (await tryRead(getGlobalConfigPath())) ?? {};
	const project = await tryRead(path.resolve(root, PROJECT_CONFIG_PATH));
	return project ? mergeProjectOverGlobal(project, global) : global;
}

/** 同步版本，供 bin 入口等非 async 上下文使用。 */
export function loadMiMoConfigSync(projectRoot?: string): MiMoConfig {
	const root = projectRoot ?? process.cwd();
	const global = tryReadSync(getGlobalConfigPath()) ?? {};
	const project = tryReadSync(path.resolve(root, PROJECT_CONFIG_PATH));
	return project ? mergeProjectOverGlobal(project, global) : global;
}
