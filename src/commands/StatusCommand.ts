import type { Command, CommandContext, CommandResult } from "./types.js";

export class StatusCommand implements Command {
	name = "status";
	description = "Show current status";
	usage = "/status";

	async execute(
		args: string[],
		context: CommandContext,
	): Promise<CommandResult> {
		return {
			success: true,
			output: `Status:
  Session: ${context.sessionId || "none"}
  Messages: ${context.messages.length}
  Working Directory: ${context.workingDirectory}`,
		};
	}
}
