import type { Command, CommandContext, CommandResult } from "./types.js";

export class CommandRegistry {
	private commands: Map<string, Command> = new Map();

	register(command: Command): void {
		this.commands.set(command.name, command);
	}

	get(name: string): Command | undefined {
		return this.commands.get(name);
	}

	list(): Command[] {
		return Array.from(this.commands.values());
	}

	async execute(
		input: string,
		context: CommandContext,
	): Promise<CommandResult> {
		if (!input.startsWith("/")) {
			return { success: false, output: "Not a command" };
		}

		const parts = input.slice(1).split(/\s+/);
		const commandName = parts[0] || "";
		const args = parts.slice(1);

		if (!commandName) {
			return { success: false, output: "Empty command" };
		}

		const command = this.commands.get(commandName);
		if (!command) {
			return { success: false, output: `Unknown command: /${commandName}` };
		}

		return command.execute(args, context);
	}

	isCommand(input: string): boolean {
		return input.startsWith("/");
	}
}
