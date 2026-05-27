import type { Command, CommandContext, CommandResult } from "./types.js";

export class CompactCommand implements Command {
	name = "compact";
	description = "Compact conversation context";
	usage = "/compact";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		return {
			success: true,
			output: "Context compacted successfully",
			data: { action: "compact" },
		};
	}
}
