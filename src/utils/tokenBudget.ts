/** 1 token ≈ 4 chars (English heuristic) used across the memory layer. */
export const CHARS_PER_TOKEN = 4;

/**
 * CharBudget — accumulate text blocks under a character cap.
 *
 * Shared by MemoryLoader (canonical prefix) and ContextPackBuilder (per-task
 * pack), which both assemble a bounded markdown document by appending blocks
 * until a token budget is exhausted. `tryPush` returns false (and flips
 * `truncated`) when a block would overflow, so callers can `break`.
 */
export class CharBudget {
	private readonly maxChars: number;
	private parts: string[] = [];
	private chars = 0;
	private _truncated = false;

	constructor(maxTokens: number) {
		this.maxChars = maxTokens * CHARS_PER_TOKEN;
	}

	/** Append unconditionally (for always-included content like a header). */
	pushAlways(block: string): void {
		this.parts.push(block);
		this.chars += block.length;
	}

	/** Append only if it fits; returns false and marks truncated otherwise. */
	tryPush(block: string): boolean {
		if (this.chars + block.length > this.maxChars) {
			this._truncated = true;
			return false;
		}
		this.parts.push(block);
		this.chars += block.length;
		return true;
	}

	/** True if any block has been rejected for overflow. */
	get truncated(): boolean {
		return this._truncated;
	}

	get text(): string {
		return this.parts.join("");
	}

	get approxTokens(): number {
		return Math.ceil(this.chars / CHARS_PER_TOKEN);
	}
}
