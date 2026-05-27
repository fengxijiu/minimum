import type { Command, CommandContext, CommandResult } from "./types.js";

export class SaveCommand implements Command {
	name = "save";
	description = "Save current session";
	usage = "/save [name]";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		const name = args[0] || context.sessionId || "default";
		return {
			success: true,
			output: `Session saved: ${name}`,
			action: "save",
			data: { sessionId: name, messages: context.messages },
		};
	}
}
