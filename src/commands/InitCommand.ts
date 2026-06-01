import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { MiMoConfig } from "../config/MiMoConfig.js";
import {
	PROJECT_CONFIG_PATH,
	getGlobalConfigPath,
} from "../config/loadMiMoConfig.js";
import {
	getGlobalMemoryRoot,
	getMemoryFile,
	getMemoryIndexPath,
	getProjectMemoryRoot,
	globalMemoryLayer,
	projectMemoryLayer,
} from "../memory/single/MemoryPaths.js";
import type { Command, CommandContext, CommandResult } from "./types.js";

// MiMo API 类型定义
type ApiType = "api" | "token-plan";
type ModelType = "mimo-v2.5-pro" | "mimo-v2.5";
type Region = "cn" | "sg" | "ams";

interface ApiConfig {
	type: ApiType;
	baseUrl: string;
	keyPrefix: string;
	keyFormat: string;
	description: string;
	keyUrl: string;
	regions?: Record<Region, string>;
}

const API_CONFIGS: Record<ApiType, ApiConfig> = {
	api: {
		type: "api",
		baseUrl: "https://api.xiaomimimo.com/v1",
		keyPrefix: "sk-",
		keyFormat: "sk-xxxxx",
		description: "按量付费 API - 按实际使用量计费，适合轻度使用",
		keyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
	},
	"token-plan": {
		type: "token-plan",
		baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
		keyPrefix: "tp-",
		keyFormat: "tp-xxxxx",
		description: "Token Plan - 固定订阅费，按套餐限量调用",
		keyUrl: "https://platform.xiaomimimo.com/#/console/plan-manage",
		regions: {
			cn: "https://token-plan-cn.xiaomimimo.com/v1",
			sg: "https://token-plan-sgp.xiaomimimo.com/v1",
			ams: "https://token-plan-ams.xiaomimimo.com/v1",
		},
	},
};

interface ModelConfig {
	name: string;
	limit: {
		context: number;
		output: number;
	};
	modalities: {
		input: string[];
		output: string[];
	};
	description: string;
}

const MODEL_CONFIGS: Record<ModelType, ModelConfig> = {
	"mimo-v2.5-pro": {
		name: "mimo-v2.5-pro",
		limit: {
			context: 1048576,
			output: 131072,
		},
		modalities: {
			input: ["text"],
			output: ["text"],
		},
		description: "专业版 - Agentic 长上下文一致性更强",
	},
	"mimo-v2.5": {
		name: "mimo-v2.5",
		limit: {
			context: 1048576,
			output: 131072,
		},
		modalities: {
			input: ["text", "image"],
			output: ["text"],
		},
		description: "标准版 - 支持图片理解，多模态能力",
	},
};

interface MinimumConfig {
	// OpenAI 兼容配置
	provider: {
		mimo: {
			npm: string;
			name: string;
			options: {
				baseURL: string;
				apiKey: string;
			};
			models: Record<string, ModelConfig>;
		};
	};
	// Minimum 扩展配置
	minimum: {
		apiType: ApiType;
		defaultModel: string;
		tools: {
			enabled: string[];
			permissions: Record<string, string>;
		};
		memory: {
			enabled: boolean;
			path: string;
		};
		skills: {
			enabled: boolean;
			path: string;
		};
		optimization: {
			validation: boolean;
			repair: boolean;
			completeness: boolean;
			context: {
				foldThreshold: number;
				aggressiveThreshold: number;
			};
			iteration: {
				maxRetries: number;
				learnFromErrors: boolean;
			};
		};
		hooks: {
			enabled: boolean;
		};
		approval: {
			mode: string;
			autoApproveLowRisk: boolean;
		};
	};
}

export interface InitOptions {
	apiKey: string;
	apiType?: ApiType;
	model?: ModelType;
	region?: Region;
	baseUrl?: string;
	enableShell?: boolean;
	enableFilesystem?: boolean;
	enableGit?: boolean;
	enableSearch?: boolean;
	enableMemory?: boolean;
	enableSkills?: boolean;
}

export class InitCommand implements Command {
	name = "init";
	description = "Initialize MiMo configuration";
	usage = "/init [--quick] [--reset]";

	private rl: readline.Interface | null = null;

	/**
	 * Non-interactive init — accepts options directly, no readline needed.
	 * Safe to call from Ink TUI (raw mode stdin).
	 */
	static async executeFromArgs(
		workingDirectory: string,
		options: InitOptions,
	): Promise<CommandResult> {
		const cmd = new InitCommand();

		const apiType =
			options.apiType ??
			(options.apiKey.startsWith("tp-") ? "token-plan" : "api");
		const apiConfig = API_CONFIGS[apiType];

		let baseUrl = options.baseUrl;
		if (
			!baseUrl &&
			apiType === "token-plan" &&
			options.region &&
			apiConfig.regions
		) {
			baseUrl = apiConfig.regions[options.region];
		}
		baseUrl = baseUrl ?? apiConfig.baseUrl;

		const model: ModelType = options.model ?? "mimo-v2.5-pro";
		const config = cmd.buildConfig(
			options.apiKey,
			apiType,
			model,
			baseUrl,
			options,
		);

		const configPath = path.join(workingDirectory, PROJECT_CONFIG_PATH);

		await cmd.saveProjectMinimumConfig(configPath, config);
		await cmd.saveMinimumGlobalConfig(config);
		await cmd.createDirectories(workingDirectory);

		// Also export env vars so MiMoClient picks them up immediately
		process.env.MIMO_API_KEY = options.apiKey;
		process.env.MIMO_BASE_URL = baseUrl;

		return {
			success: true,
			output: cmd.formatSuccessMessage(
				config,
				configPath,
				getGlobalConfigPath(),
			),
			data: { config },
		};
	}

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		const isQuick = args.includes("--quick");
		const isReset = args.includes("--reset");

		// 检查是否已存在配置
		const configPath = path.join(context.workingDirectory, PROJECT_CONFIG_PATH);

		if (!isReset) {
			try {
				await fs.access(configPath);
				return {
					success: false,
					output: `Configuration already exists at ${configPath}\nUse /init --reset to reinitialize`,
				};
			} catch {
				// 配置不存在，继续初始化
			}
		}

		// 创建readline接口
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		try {
			let config: MinimumConfig;

			if (isQuick) {
				config = await this.quickSetup();
			} else {
				config = await this.interactiveSetup(context);
			}

			// 保存配置（仅 .minimum/ 下两份）
			await this.saveProjectMinimumConfig(configPath, config);
			await this.saveMinimumGlobalConfig(config);

			// 创建必要的目录
			await this.createDirectories(context.workingDirectory);

			return {
				success: true,
				output: this.formatSuccessMessage(
					config,
					configPath,
					getGlobalConfigPath(),
				),
				data: { config },
			};
		} catch (error: any) {
			return {
				success: false,
				output: `Initialization failed: ${error.message}`,
			};
		} finally {
			this.rl?.close();
		}
	}

	private async quickSetup(): Promise<MinimumConfig> {
		// 选择API类型
		console.log("\n📡 API Type Selection");
		console.log("  1. 按量付费 API (Pay-as-you-go)");
		console.log("  2. Token Plan (订阅制)");
		const apiTypeChoice = await this.ask(
			"\nSelect API type (1/2, default: 1): ",
		);
		const apiType: ApiType = apiTypeChoice === "2" ? "token-plan" : "api";
		const apiConfig = API_CONFIGS[apiType];

		// Token Plan 选择区域
		let baseUrl = apiConfig.baseUrl;
		if (apiType === "token-plan" && apiConfig.regions) {
			console.log("\n🌏 Region Selection");
			console.log("  1. China (cn)");
			console.log("  2. Singapore (sg)");
			console.log("  3. Europe (ams)");
			const regionChoice = await this.ask(
				"Select region (1/2/3, default: 1): ",
			);
			const region: Region =
				regionChoice === "2" ? "sg" : regionChoice === "3" ? "ams" : "cn";
			baseUrl = apiConfig.regions[region];
		}

		console.log(`\n  Base URL: ${baseUrl}`);
		console.log(`  API Key format: ${apiConfig.keyFormat}`);
		console.log(`  Get key at: ${apiConfig.keyUrl}\n`);

		const apiKey = await this.ask(`API Key (${apiConfig.keyPrefix}xxxxx): `);

		// 选择模型
		console.log("\n🤖 Model Selection");
		console.log("  1. mimo-v2.5-pro - 专业版，Agentic 长上下文一致性更强");
		console.log("  2. mimo-v2.5     - 标准版，支持图片理解，多模态能力");
		const modelChoice = await this.ask("Select model (1/2, default: 1): ");
		const model: ModelType =
			modelChoice === "2" ? "mimo-v2.5" : "mimo-v2.5-pro";

		return this.createDefaultConfig(apiKey, apiType, model, baseUrl);
	}

	private async interactiveSetup(
		context: CommandContext,
	): Promise<MinimumConfig> {
		console.log("\n🚀 MiMo Configuration Setup\n");

		// API类型配置
		console.log("📡 API Type Configuration");
		console.log("  1. 按量付费 API (Pay-as-you-go)");
		console.log("     - 按实际使用量计费，适合轻度使用");
		console.log("     - API Key: sk-xxxxx");
		console.log(
			"     - 获取: https://platform.xiaomimimo.com/#/console/api-keys",
		);
		console.log();
		console.log("  2. Token Plan (订阅制)");
		console.log("     - 固定订阅费，按套餐限量调用");
		console.log("     - API Key: tp-xxxxx");
		console.log(
			"     - 获取: https://platform.xiaomimimo.com/#/console/plan-manage",
		);
		console.log();

		const apiTypeChoice = await this.ask("Select API type (1/2, default: 1): ");
		const apiType: ApiType = apiTypeChoice === "2" ? "token-plan" : "api";
		const apiConfig = API_CONFIGS[apiType];

		// Token Plan 选择区域
		let baseUrl = apiConfig.baseUrl;
		if (apiType === "token-plan" && apiConfig.regions) {
			console.log("\n🌏 Region Selection");
			console.log("  1. China (cn) - https://token-plan-cn.xiaomimimo.com/v1");
			console.log(
				"  2. Singapore (sg) - https://token-plan-sgp.xiaomimimo.com/v1",
			);
			console.log(
				"  3. Europe (ams) - https://token-plan-ams.xiaomimimo.com/v1",
			);
			const regionChoice = await this.ask(
				"Select region (1/2/3, default: 1): ",
			);
			const region: Region =
				regionChoice === "2" ? "sg" : regionChoice === "3" ? "ams" : "cn";
			baseUrl = apiConfig.regions[region];
		}

		const apiKey = await this.ask(`\nAPI Key (${apiConfig.keyFormat}): `);

		// 模型选择
		console.log("\n🤖 Model Selection");
		console.log("  1. mimo-v2.5-pro");
		console.log("     - 专业版，Agentic 长上下文一致性更强");
		console.log("     - 输入: text");
		console.log("     - Context: 1,048,576 tokens");
		console.log();
		console.log("  2. mimo-v2.5");
		console.log("     - 标准版，支持图片理解，多模态能力");
		console.log("     - 输入: text, image");
		console.log("     - Context: 1,048,576 tokens");
		console.log();

		const modelChoice = await this.ask("Select model (1/2, default: 1): ");
		const model: ModelType =
			modelChoice === "2" ? "mimo-v2.5" : "mimo-v2.5-pro";

		// Tools配置
		console.log("\n🔧 Tools Configuration");
		const enableFilesystem = await this.ask("Enable filesystem tools? (Y/n): ");
		const enableShell = await this.ask("Enable shell tools? (y/N): ");
		const enableGit = await this.ask("Enable git tools? (Y/n): ");
		const enableSearch = await this.ask("Enable search tools? (Y/n): ");

		const enabledTools: string[] = [];
		if (enableFilesystem.toLowerCase() !== "n") enabledTools.push("filesystem");
		if (enableShell.toLowerCase() === "y") enabledTools.push("shell");
		if (enableGit.toLowerCase() !== "n") enabledTools.push("git");
		if (enableSearch.toLowerCase() !== "n") enabledTools.push("search");

		// Memory配置
		console.log("\n💾 Memory Configuration");
		const enableMemory = await this.ask("Enable memory system? (Y/n): ");
		const memoryPath =
			(await this.ask("Memory path (default: ~/.minimum/memory): ")) ||
			"~/.minimum/memory";

		// Skills配置
		console.log("\n🎯 Skills Configuration");
		const enableSkills = await this.ask("Enable skills system? (Y/n): ");

		// Optimization配置
		console.log("\n⚡ Optimization Configuration");
		const enableValidation = await this.ask("Enable code validation? (Y/n): ");
		const enableRepair = await this.ask("Enable tool call repair? (Y/n): ");
		const enableCompleteness = await this.ask(
			"Enable completeness check? (Y/n): ",
		);
		const foldThreshold = Number.parseFloat(
			(await this.ask("Context fold threshold (default: 0.70): ")) || "0.70",
		);
		const maxRetries = Number.parseInt(
			(await this.ask("Max iteration retries (default: 3): ")) || "3",
		);

		// Approval配置
		console.log("\n🔐 Approval Configuration");
		const approvalMode =
			(await this.ask(
				"Approval mode (auto/suggest/never, default: suggest): ",
			)) || "suggest";

		// 构建模型配置
		const models: Record<string, ModelConfig> = {};
		models[model] = MODEL_CONFIGS[model];

		return {
			provider: {
				mimo: {
					npm: "@ai-sdk/openai-compatible",
					name: "MiMo",
					options: {
						baseURL: baseUrl,
						apiKey,
					},
					models,
				},
			},
			minimum: {
				apiType,
				defaultModel: model,
				tools: {
					enabled: enabledTools,
					permissions: {
						shell: enableShell.toLowerCase() === "y" ? "allow" : "ask",
						filesystem: "allow",
					},
				},
				memory: {
					enabled: enableMemory.toLowerCase() !== "n",
					path: memoryPath,
				},
				skills: {
					enabled: enableSkills.toLowerCase() !== "n",
					path: "./skills",
				},
				optimization: {
					validation: enableValidation.toLowerCase() !== "n",
					repair: enableRepair.toLowerCase() !== "n",
					completeness: enableCompleteness.toLowerCase() !== "n",
					context: {
						foldThreshold,
						aggressiveThreshold: 0.75,
					},
					iteration: {
						maxRetries,
						learnFromErrors: true,
					},
				},
				hooks: {
					enabled: true,
				},
				approval: {
					mode: approvalMode,
					autoApproveLowRisk: true,
				},
			},
		};
	}

	private buildConfig(
		apiKey: string,
		apiType: ApiType,
		model: ModelType,
		baseUrl: string,
		opts: InitOptions,
	): MinimumConfig {
		const models: Record<string, ModelConfig> = {};
		models[model] = MODEL_CONFIGS[model];

		const enabledTools: string[] = [];
		if (opts.enableFilesystem !== false) enabledTools.push("filesystem");
		if (opts.enableShell) enabledTools.push("shell");
		if (opts.enableGit !== false) enabledTools.push("git");
		if (opts.enableSearch !== false) enabledTools.push("search");

		return {
			provider: {
				mimo: {
					npm: "@ai-sdk/openai-compatible",
					name: "MiMo",
					options: { baseURL: baseUrl, apiKey },
					models,
				},
			},
			minimum: {
				apiType,
				defaultModel: model,
				tools: {
					enabled: enabledTools,
					permissions: {
						shell: opts.enableShell ? "allow" : "ask",
						filesystem: "allow",
					},
				},
				memory: {
					enabled: opts.enableMemory !== false,
					path: "~/.minimum/memory",
				},
				skills: { enabled: opts.enableSkills !== false, path: "./skills" },
				optimization: {
					validation: true,
					repair: true,
					completeness: true,
					context: { foldThreshold: 0.7, aggressiveThreshold: 0.75 },
					iteration: { maxRetries: 3, learnFromErrors: true },
				},
				hooks: { enabled: true },
				approval: { mode: "suggest", autoApproveLowRisk: true },
			},
		};
	}

	private createDefaultConfig(
		apiKey: string,
		apiType: ApiType,
		model: ModelType,
		baseUrl?: string,
	): MinimumConfig {
		const apiConfig = API_CONFIGS[apiType];
		const models: Record<string, ModelConfig> = {};
		models[model] = MODEL_CONFIGS[model];

		return {
			provider: {
				mimo: {
					npm: "@ai-sdk/openai-compatible",
					name: "MiMo",
					options: {
						baseURL: baseUrl || apiConfig.baseUrl,
						apiKey,
					},
					models,
				},
			},
			minimum: {
				apiType,
				defaultModel: model,
				tools: {
					enabled: ["filesystem", "git", "search"],
					permissions: {
						shell: "ask",
						filesystem: "allow",
					},
				},
				memory: {
					enabled: true,
					path: "~/.minimum/memory",
				},
				skills: {
					enabled: true,
					path: "./skills",
				},
				optimization: {
					validation: true,
					repair: true,
					completeness: true,
					context: {
						foldThreshold: 0.7,
						aggressiveThreshold: 0.75,
					},
					iteration: {
						maxRetries: 3,
						learnFromErrors: true,
					},
				},
				hooks: {
					enabled: true,
				},
				approval: {
					mode: "suggest",
					autoApproveLowRisk: true,
				},
			},
		};
	}

	/** 把 InitCommand 的内部 MinimumConfig 投影成引擎消费的 MiMoConfig 形状。 */
	private toMiMoConfig(config: MinimumConfig): MiMoConfig {
		const opt = config.minimum.optimization;
		return {
			apiKey: config.provider.mimo.options.apiKey,
			baseUrl: config.provider.mimo.options.baseURL,
			defaultModel: config.minimum.defaultModel,
			approvalMode: config.minimum.approval.mode as MiMoConfig["approvalMode"],
			validation: { enabled: opt.validation },
			completeness: { enabled: opt.completeness },
			context: {
				foldThreshold: opt.context.foldThreshold,
				aggressiveThreshold: opt.context.aggressiveThreshold,
			},
		};
	}

	/**
	 * 写入 `<project>/.minimum/config.json` —— 项目级标准位置。
	 * 凭证省略（继承全局），仅记录项目专属覆盖。
	 */
	private async saveProjectMinimumConfig(
		configPath: string,
		config: MinimumConfig,
	): Promise<void> {
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		const minimumConfig = this.toMiMoConfig(config);
		// 项目配置不含凭证：避免被误 git commit；引擎会从全局/env 取
		minimumConfig.apiKey = undefined;
		minimumConfig.baseUrl = undefined;
		await fs.writeFile(configPath, JSON.stringify(minimumConfig, null, 2));
	}

	/**
	 * 写入 `~/.minimum/config.json` —— minimum 引擎直接消费的 MiMoConfig 形状。
	 * loadMiMoConfig 没找到项目级配置时会回退到这里，所以 `init` 之后任何目录都能直接 `minimum`。
	 */
	private async saveMinimumGlobalConfig(config: MinimumConfig): Promise<void> {
		await fs.mkdir(path.dirname(getGlobalConfigPath()), { recursive: true });
		const minimumConfig = this.toMiMoConfig(config);
		await fs.writeFile(
			getGlobalConfigPath(),
			JSON.stringify(minimumConfig, null, 2),
		);
		// chmod 0600 — 仅 owner 可读，避免 API key 泄漏给其他用户
		try {
			await fs.chmod(getGlobalConfigPath(), 0o600);
		} catch {
			/* Windows / 非 POSIX 文件系统 */
		}
	}

	private async createDirectories(projectRoot: string): Promise<void> {
		const home = os.homedir() || process.env.HOME || "~";
		const projectMemoryRoot = getProjectMemoryRoot(projectRoot);
		const globalMemoryRoot = getGlobalMemoryRoot(home);
		const dirs = [
			path.join(projectRoot, ".minimum"),
			projectMemoryRoot,
			path.join(projectRoot, ".minimum", "sessions"),
			path.join(projectRoot, ".minimum", "checkpoints"),
			path.join(projectRoot, ".minimum", "skills"),
			path.join(projectRoot, ".minimum", "transcripts"),
			path.join(home, ".minimum"),
			globalMemoryRoot,
			path.join(home, ".minimum", "sessions"),
			path.join(home, ".minimum", "skills"),
		];

		for (const dir of dirs) {
			await fs.mkdir(dir, { recursive: true });
		}

		await Promise.all([
			this.ensureCanonicalMarkdownTemplates(projectRoot),
			this.ensureGlobalMemoryIndex(home),
		]);
	}

	private async ensureCanonicalMarkdownTemplates(projectRoot: string): Promise<void> {
		const templates: Record<string, string> = {
			project: "# Project Memory\n\n## Overview\n- Add stable project facts here.\n",
			architecture:
				"# Architecture Memory\n\n## Decisions\n- Record long-lived architectural decisions here.\n",
			conventions:
				"# Conventions Memory\n\n## Coding Standards\n- Record durable conventions here.\n",
			"repo-map": "# Repo Map Memory\n\n## Key Paths\n- Document important paths here.\n",
			tests: "# Test Memory\n\n## Commands\n- Record reliable test commands here.\n",
		};

		for (const [key, content] of Object.entries(templates)) {
			await this.writeFileIfMissing(
				getMemoryFile(projectMemoryLayer(projectRoot), key),
				content,
			);
		}
		await this.writeFileIfMissing(
			getMemoryIndexPath(projectMemoryLayer(projectRoot)),
			`${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`,
		);
	}

	private async ensureGlobalMemoryIndex(home: string): Promise<void> {
		await this.writeFileIfMissing(
			getMemoryIndexPath(globalMemoryLayer(home)),
			`${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`,
		);
	}

	private async writeFileIfMissing(filePath: string, content: string): Promise<void> {
		try {
			await fs.access(filePath);
		} catch {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, "utf-8");
		}
	}

	private formatSuccessMessage(
		config: MinimumConfig,
		configPath: string,
		globalConfigPath: string,
	): string {
		const apiConfig = API_CONFIGS[config.minimum.apiType];
		const modelConfig = MODEL_CONFIGS[config.minimum.defaultModel as ModelType];

		return `
╔═══════════════════════════════════════════════════════════════╗
║                    ✅ Configuration Complete                   ║
╚═══════════════════════════════════════════════════════════════╝

📡 API Configuration:
   • Type: ${apiConfig.description}
   • Base URL: ${config.provider.mimo.options.baseURL}

🤖 Model Configuration:
   • Model: ${config.minimum.defaultModel}
   • Description: ${modelConfig.description}
   • Context: ${modelConfig.limit.context.toLocaleString()} tokens
   • Output: ${modelConfig.limit.output.toLocaleString()} tokens
   • Input Modalities: ${modelConfig.modalities.input.join(", ")}

📁 Configuration files created:
   • Project: ${configPath}   (无凭证 · 可安全 git commit)
   • Global:  ${globalConfigPath}   (含 apiKey · chmod 0600)
   ↑ minimum 引擎会自动读取全局配置，无需 env 变量

📂 Directories created:
   • .minimum/
   • .minimum/memory/   (canonical markdown + auxiliary index.json)
   • .minimum/sessions/
   • .minimum/checkpoints/
   • .minimum/skills/
   • .minimum/transcripts/

🚀 Quick Start:
   1. Start coding: minimum
   2. Type your task and press Enter

📖 Commands:
   /help     - Show help
   /status   - Show status
   /config   - View configuration
   /new      - Start new session

Happy coding! 🎉
`;
	}

	private ask(question: string): Promise<string> {
		return new Promise((resolve) => {
			this.rl?.question(question, (answer) => {
				resolve(answer.trim());
			});
		});
	}
}
