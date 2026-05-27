export interface CommandContext {
	workingDirectory: string;
	sessionId?: string;
	messages: any[];
	config: Record<string, any>;
}

export interface CommandResult {
	success: boolean;
	output: string;
	action?: "clear" | "save" | "load" | "exit";
	data?: any;
}

export interface Command {
	name: string;
	description: string;
	usage: string;
	execute(args: string[], context: CommandContext): Promise<CommandResult>;
}
