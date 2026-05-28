import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
	Hook,
	HookConfig,
	HookContext,
	HookEvent,
	HookResult,
} from "./types.js";

const execAsync = promisify(exec);

export class HookManager {
	private hooks: Map<HookEvent, Hook[]> = new Map();
	private nextId = 1;

	register(config: HookConfig): string {
		const id = `hook_${this.nextId++}`;

		const hook: Hook = {
			id,
			event: config.event,
			command: config.command,
			match: config.match ? new RegExp(config.match) : undefined,
			timeout: config.timeout || 5000,
			description: config.description,
		};

		const hooks = this.hooks.get(config.event) || [];
		hooks.push(hook);
		this.hooks.set(config.event, hooks);

		return id;
	}

	unregister(id: string): boolean {
		for (const [event, hooks] of this.hooks) {
			const index = hooks.findIndex((h) => h.id === id);
			if (index !== -1) {
				hooks.splice(index, 1);
				return true;
			}
		}
		return false;
	}

	async execute(event: HookEvent, context: HookContext): Promise<HookResult[]> {
		const hooks = this.hooks.get(event) || [];
		const results: HookResult[] = [];

		for (const hook of hooks) {
			// 检查匹配条件
			if (hook.match && context.toolName) {
				if (!hook.match.test(context.toolName)) {
					continue;
				}
			}

			const result = await this.runHook(hook, context);
			results.push(result);
		}

		return results;
	}

	private async runHook(hook: Hook, context: HookContext): Promise<HookResult> {
		const startTime = Date.now();

		try {
			// 设置环境变量
			const env: Record<string, string> = {
				...(process.env as Record<string, string>),
				HOOK_EVENT: hook.event,
				WORKING_DIRECTORY: context.workingDirectory,
			};

			if (context.toolName) {
				env.TOOL_NAME = context.toolName;
			}
			if (context.toolArgs) {
				env.TOOL_ARGS = JSON.stringify(context.toolArgs);
			}
			if (context.userPrompt) {
				env.USER_PROMPT = context.userPrompt;
			}

			const { stdout, stderr } = await execAsync(hook.command, {
				env,
				timeout: hook.timeout,
				cwd: context.workingDirectory,
			});

			return {
				hookId: hook.id,
				success: true,
				exitCode: 0,
				stdout: stdout || "",
				stderr: stderr || "",
				duration: Date.now() - startTime,
			};
		} catch (error: any) {
			return {
				hookId: hook.id,
				success: false,
				exitCode: error.code || 1,
				stdout: error.stdout || "",
				stderr: error.stderr || error.message,
				duration: Date.now() - startTime,
			};
		}
	}

	getHooks(event?: HookEvent): Hook[] {
		if (event) {
			return this.hooks.get(event) || [];
		}

		const allHooks: Hook[] = [];
		for (const hooks of this.hooks.values()) {
			allHooks.push(...hooks);
		}
		return allHooks;
	}

	clear(): void {
		this.hooks.clear();
	}
}
