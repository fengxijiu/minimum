import {
	inspectCanonical,
	inspectStaging,
	renderMemoryReport,
} from "../memory/governance/index.js";
import type { Command, CommandContext, CommandResult } from "./types.js";

export class MemoryCommand implements Command {
	name = "memory";
	description = "Inspect the .minimum governance memory (canonical + staging)";
	usage = "/memory [status|canonical|staging]";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		const subcommand = args[0] || "status";
		const root = context.workingDirectory;

		switch (subcommand) {
			case "status": {
				const [canonical, staging] = await Promise.all([
					inspectCanonical(root),
					inspectStaging(root),
				]);
				return { success: true, output: renderMemoryReport(canonical, staging) };
			}
			case "canonical": {
				const canonical = await inspectCanonical(root);
				return { success: true, output: renderMemoryReport(canonical, []) };
			}
			case "staging": {
				const staging = await inspectStaging(root);
				return { success: true, output: renderMemoryReport([], staging) };
			}
			default:
				return {
					success: false,
					output: `Unknown subcommand: ${subcommand}\nUsage: ${this.usage}`,
				};
		}
	}
}
