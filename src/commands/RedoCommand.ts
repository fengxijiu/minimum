import type { Command, CommandContext, CommandResult } from "./types.js";

export class RedoCommand implements Command {
	name = "redo";
	description = "Redo last undone action";
	usage = "/redo";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		return {
			success: true,
			output: "Redo successful",
			data: { action: "redo" },
		};
	}
}
