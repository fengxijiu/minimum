import type { Command, CommandContext, CommandResult } from "./types.js";

export class MemoryCommand implements Command {
	name = "memory";
	description = "Manage memory";
	usage = "/memory [list|set|get|clear] [key] [value]";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		const subcommand = args[0] || "list";

		switch (subcommand) {
			case "list":
				return { success: true, output: "Memory entries listed" };
			case "set":
				return { success: true, output: `Memory set: ${args[1]} = ${args[2]}` };
			case "get":
				return { success: true, output: `Memory get: ${args[1]}` };
			case "clear":
				return { success: true, output: "Memory cleared" };
			default:
				return { success: false, output: `Unknown subcommand: ${subcommand}` };
		}
	}
}
