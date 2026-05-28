import { CommandRegistry } from "./CommandRegistry.js";
import { CompactCommand } from "./CompactCommand.js";
import { ConfigCommand } from "./ConfigCommand.js";
import { InitCommand } from "./InitCommand.js";
import { LoadCommand } from "./LoadCommand.js";
import { MemoryCommand } from "./MemoryCommand.js";
import { NewCommand } from "./NewCommand.js";
import { RedoCommand } from "./RedoCommand.js";
import { SaveCommand } from "./SaveCommand.js";
import { SkillCommand } from "./SkillCommand.js";
import { StatusCommand } from "./StatusCommand.js";
import { UndoCommand } from "./UndoCommand.js";

export { CommandRegistry } from "./CommandRegistry.js";
export type { Command, CommandContext, CommandResult } from "./types.js";

export { NewCommand } from "./NewCommand.js";
export { SaveCommand } from "./SaveCommand.js";
export { LoadCommand } from "./LoadCommand.js";
export { CompactCommand } from "./CompactCommand.js";
export { UndoCommand } from "./UndoCommand.js";
export { RedoCommand } from "./RedoCommand.js";
export { SkillCommand } from "./SkillCommand.js";
export { MemoryCommand } from "./MemoryCommand.js";
export { ConfigCommand } from "./ConfigCommand.js";
export { StatusCommand } from "./StatusCommand.js";
export { InitCommand, type InitOptions } from "./InitCommand.js";

export function createDefaultRegistry(): CommandRegistry {
	const registry = new CommandRegistry();

	registry.register(new InitCommand());
	registry.register(new NewCommand());
	registry.register(new SaveCommand());
	registry.register(new LoadCommand());
	registry.register(new CompactCommand());
	registry.register(new UndoCommand());
	registry.register(new RedoCommand());
	registry.register(new SkillCommand());
	registry.register(new MemoryCommand());
	registry.register(new ConfigCommand());
	registry.register(new StatusCommand());

	return registry;
}
