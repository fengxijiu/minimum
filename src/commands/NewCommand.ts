import type { Command, CommandContext, CommandResult } from "./types.js";

export class NewCommand implements Command {
	name = "new";
	description = "Start a new session";
	usage = "/new [name]";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		const name = args[0] || `session_${Date.now()}`;
		return {
			success: true,
			output: `Started new session: ${name}`,
			action: "clear",
			data: { sessionId: name },
		};
	}
}
