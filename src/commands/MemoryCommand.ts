import { MemoryCommandService } from "../memory/governance/index.js";
import type { Command, CommandContext, CommandResult } from "./types.js";

export class MemoryCommand implements Command {
	name = "memory";
	description = "Inspect and manage the .minimum governance memory";
	usage =
		"/memory [status|project|global|staging|approve <id>|reject <id>|forget <id>|compact|on|off]";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		const subcommand = args[0] || "status";
		const service = new MemoryCommandService(context.workingDirectory, {
			injectionBudgetTokens: this.resolveInjectionBudget(context),
		});

		switch (subcommand) {
			case "status": {
				const status = await service.status();
				return { success: true, output: service.renderStatus(status), data: status };
			}
			case "project":
				return { success: true, output: await service.project() };
			case "global":
				return { success: true, output: await service.global() };
			case "staging":
				return { success: true, output: await service.staging() };
			case "approve":
				return this.withRequiredId(args, async (id) => ({
					success: true,
					output: await service.approve(id),
				}));
			case "reject":
				return this.withRequiredId(args, async (id) => ({
					success: true,
					output: await service.reject(id),
				}));
			case "forget":
				return this.withRequiredId(args, async (id) => ({
					success: true,
					output: await service.forget(id),
				}));
			case "compact":
				return { success: true, output: await service.compact(), data: { action: "compact" } };
			case "on":
				return { success: true, output: await service.enable() };
			case "off":
				return { success: true, output: await service.disable() };
			default:
				return {
					success: false,
					output: `Unknown subcommand: ${subcommand}\nUsage: ${this.usage}`,
				};
		}
	}

	private async withRequiredId(
		args: string[],
		run: (id: string) => Promise<CommandResult>,
	): Promise<CommandResult> {
		const id = args[1];
		if (!id) {
			return { success: false, output: `Missing id\nUsage: ${this.usage}` };
		}
		return run(id);
	}

	private resolveInjectionBudget(context: CommandContext): number | undefined {
		const memoryConfig = context.config.memory;
		if (memoryConfig && typeof memoryConfig === "object") {
			const budget =
				memoryConfig.injectionBudgetTokens ??
				memoryConfig.injectionBudget ??
				memoryConfig.maxTokens;
			if (typeof budget === "number") return budget;
		}
		return undefined;
	}
}
