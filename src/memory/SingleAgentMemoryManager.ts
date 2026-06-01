import type { MemoryConfig } from "../config/MiMoConfig.js";
import type {
	ISingleAgentMemoryManager,
	MemoryInjectionRequest,
	MemoryInjectionResult,
	MemoryWritebackRequest,
} from "./single/types.js";
import { SingleAgentMemoryManager as FullSingleAgentMemoryManager } from "./single/SingleAgentMemoryManager.js";

export interface SingleAgentMemoryManagerOptions {
	workingDirectory: string;
	config: MemoryConfig;
}

export class SingleAgentMemoryManager implements ISingleAgentMemoryManager {
	readonly workingDirectory: string;
	readonly config: MemoryConfig;
	readonly impl: FullSingleAgentMemoryManager;

	constructor(options: SingleAgentMemoryManagerOptions) {
		this.workingDirectory = options.workingDirectory;
		this.config = options.config;
		this.impl = new FullSingleAgentMemoryManager({
			projectRoot: options.workingDirectory,
			globalBasePath: options.config.globalBasePath,
			maxPreludeEntries: options.config.maxPreludeEntries,
			maxStoredEntries: options.config.maxStoredEntries,
		});
	}

	buildPrelude(request: MemoryInjectionRequest): Promise<MemoryInjectionResult> {
		return this.impl.buildPrelude(request);
	}

	writeback(request: MemoryWritebackRequest): Promise<void> {
		return this.impl.writeback(request);
	}
}
