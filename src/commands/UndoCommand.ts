import type { Command, CommandContext, CommandResult } from "./types.js";

export class UndoCommand implements Command {
	name = "undo";
	description = "Undo last action";
	usage = "/undo";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		return {
			success: true,
			output: "Undo successful",
			data: { action: "undo" },
		};
	}
}
