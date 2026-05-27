import type { Command, CommandContext, CommandResult } from "./types.js";

export class LoadCommand implements Command {
	name = "load";
	description = "Load a saved session";
	usage = "/load <name>";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		if (args.length === 0) {
			return { success: false, output: "Usage: /load <session-name>" };
		}

		return {
			success: true,
			output: `Session loaded: ${args[0]}`,
			action: "load",
			data: { sessionId: args[0] },
		};
	}
}
