import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MiMoConfig } from "./MiMoConfig.js";

/** 动态解析 home：测试可通过修改 process.env.HOME 隔离全局配置。 */
function resolveHome(): string {
	return process.env.HOME ?? os.homedir() ?? "~";
}

/** `~/.minimum/config.json` —— 由 `init` 注册的全局默认配置，每次调用重新解析 HOME。 */
export function getGlobalConfigPath(): string {
	return path.join(resolveHome(), ".minimum", "config.json");
}

/**
 * @deprecated 使用 getGlobalConfigPath() 替代。保留作向后兼容字符串。
 * 注意：此常量在模块加载时计算一次，不响应运行时 HOME 变化。
 */
export const GLOBAL_CONFIG_PATH: string = getGlobalConfigPath();

/** 项目级标准配置路径（init 写入这里）。 */
export const PROJECT_CONFIG_PATH = ".minimum/config.json";

// 项目级配置优先于全局；前者为标准路径，后续为旧版兼容（init 不再写）。
const PROJECT_CONFIG_PATHS = [
	PROJECT_CONFIG_PATH, // 新标准
	".mimo/config.json", // 旧版兼容
	".mimo.json", // 旧版兼容
	"opencode.json", // 旧版 init 兼容
];

/**
 * 把 `init` 写出的 opencode.json（{ minimum: { optimization, ... } }）翻译成 MiMoConfig。
 * 同时支持 provider.mimo.options.apiKey 字段（init 老格式）。
 */
function fromOpenCode(raw: any): MiMoConfig {
	const cfg: MiMoConfig = {};

	// 从 provider.mimo.options 抽取凭证（init 老格式）
	const opts = raw?.provider?.mimo?.options;
	if (opts?.apiKey && !/\$\{/.test(String(opts.apiKey)))
		cfg.apiKey = String(opts.apiKey);
	if (opts?.baseURL && !/\$\{/.test(String(opts.baseURL)))
		cfg.baseUrl = String(opts.baseURL);

	const min = raw?.minimum;
	if (!min) return cfg;

	if (min.defaultModel) cfg.defaultModel = String(min.defaultModel);
	if (min.approval?.mode) cfg.approvalMode = min.approval.mode;

	// When apiType is "token-plan" and no explicit baseUrl was found above,
	// auto-select the Token Plan CN endpoint so users don't need MIMO_BASE_URL.
	if (min.apiType === "token-plan" && !cfg.baseUrl) {
		cfg.baseUrl = "https://token-plan-cn.xiaomimimo.com/v1";
	}

	const opt = min.optimization ?? {};
	if (opt.validation !== undefined)
		cfg.validation = { enabled: !!opt.validation };
	if (opt.completeness !== undefined)
		cfg.completeness = { enabled: !!opt.completeness };
	if (opt.context) {
		cfg.context = {
			...(opt.context.foldThreshold !== undefined && {
				foldThreshold: opt.context.foldThreshold,
			}),
			...(opt.context.aggressiveThreshold !== undefined && {
				aggressiveThreshold: opt.context.aggressiveThreshold,
			}),
		};
	}
	return cfg;
}

function parseConfig(text: string): MiMoConfig {
	const raw = JSON.parse(text);
	// opencode.json 形状：含 "provider" 或 "minimum" 顶层键 → 走兼容翻译
	if ("minimum" in raw || "provider" in raw) return fromOpenCode(raw);
	return raw as MiMoConfig;
}

async function tryRead(absPath: string): Promise<MiMoConfig | null> {
	try {
		const text = await fs.readFile(absPath, "utf-8");
		return parseConfig(text);
	} catch {
		return null;
	}
}

function tryReadSync(absPath: string): MiMoConfig | null {
	try {
		return parseConfig(readFileSync(absPath, "utf-8"));
	} catch {
		return null;
	}
}

/** 项目配置覆盖全局：project { apiKey: "" } 不会盖掉 global apiKey */
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
	// 子对象浅合并
	if (project.context) out.context = { ...global.context, ...project.context };
	if (project.capacity)
		out.capacity = { ...global.capacity, ...project.capacity };
	if (project.validation)
		out.validation = { ...global.validation, ...project.validation };
	return out;
}

/**
 * 加载 MiMo 配置：项目级优先，回退到全局 `~/.minimum/config.json`。
 * 项目内显式设置的字段会覆盖全局同名字段，未设置的字段继承全局。
 */
export async function loadMiMoConfig(
	projectRoot?: string,
): Promise<MiMoConfig> {
	const root = projectRoot ?? process.cwd();
	const global = (await tryRead(getGlobalConfigPath())) ?? {};

	for (const rel of PROJECT_CONFIG_PATHS) {
		const project = await tryRead(path.resolve(root, rel));
		if (project) return mergeProjectOverGlobal(project, global);
	}

	return global;
}

/** 同步版本，供 bin 入口等非 async 上下文使用。 */
export function loadMiMoConfigSync(projectRoot?: string): MiMoConfig {
	const root = projectRoot ?? process.cwd();
	const global = tryReadSync(getGlobalConfigPath()) ?? {};

	for (const rel of PROJECT_CONFIG_PATHS) {
		const project = tryReadSync(path.resolve(root, rel));
		if (project) return mergeProjectOverGlobal(project, global);
	}

	return global;
}
