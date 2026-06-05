import { refreshMemoryIndex } from "./MemoryIndex.js";

export class MemoryIndexRefreshScheduler {
	private dirty = false;
	private reasons: string[] = [];

	markDirty(reason: string): void {
		this.dirty = true;
		this.reasons.push(reason);
	}

	async flushIfDirty(projectRoot: string): Promise<void> {
		if (!this.dirty) return;
		await refreshMemoryIndex(projectRoot);
		this.dirty = false;
		this.reasons = [];
	}

	isDirty(): boolean {
		return this.dirty;
	}
}
