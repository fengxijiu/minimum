import * as fs from "node:fs/promises";

export class PipelineCache {
	private fileReads = new Map<string, { content: string; mtime: number }>();
	private commandResults = new Map<string, { output: string; exitCode: number }>();

	async readCached(filePath: string): Promise<string | null> {
		const entry = this.fileReads.get(filePath);
		if (!entry) return null;
		try {
			const stat = await fs.stat(filePath);
			if (stat.mtimeMs > entry.mtime) return null;
		} catch {
			return null;
		}
		return entry.content;
	}

	cacheFileRead(filePath: string, content: string, mtime: number): void {
		this.fileReads.set(filePath, { content, mtime });
	}

	cacheCommandResult(key: string, output: string, exitCode: number): void {
		this.commandResults.set(key, { output, exitCode });
	}

	getCachedCommand(key: string): { output: string; exitCode: number } | undefined {
		return this.commandResults.get(key);
	}

	invalidateFile(filePath: string): void {
		this.fileReads.delete(filePath);
	}

	invalidateWorkingTreeDerived(): void {
		this.commandResults.clear();
	}
}
