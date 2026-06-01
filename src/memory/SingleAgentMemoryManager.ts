import type { MemoryConfig } from "../config/MiMoConfig.js";

export interface SingleAgentMemoryManagerOptions {
	workingDirectory: string;
	config: MemoryConfig;
}

/**
 * SingleAgentMemoryManager owns the opt-in single-agent memory lifecycle.
 *
 * The current stack wires it up from configuration so memory behavior can be
 * enabled, disabled, and tuned centrally. Injection/writeback implementation
 * can build on this object without changing createMiMoStack again.
 */
export class SingleAgentMemoryManager {
	readonly workingDirectory: string;
	readonly config: MemoryConfig;

	constructor(options: SingleAgentMemoryManagerOptions) {
		this.workingDirectory = options.workingDirectory;
		this.config = options.config;
	}
}
