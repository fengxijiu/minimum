import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface MemoryEntry {
	key: string;
	value: string;
	type: "user" | "project" | "session";
	timestamp: number;
	metadata?: Record<string, any>;
}

export interface MemoryStoreOptions {
	basePath?: string;
	maxSize?: number;
}

export class MemoryStore {
	private basePath: string;
	private maxSize: number;
	private cache: Map<string, MemoryEntry> = new Map();

	constructor(options: MemoryStoreOptions = {}) {
		this.basePath =
			options.basePath ||
			path.join(process.env.HOME || "~", ".minimum", "memory");
		this.maxSize = options.maxSize || 1000;
	}

	async initialize(): Promise<void> {
		try {
			await fs.mkdir(this.basePath, { recursive: true });
			await this.loadFromDisk();
		} catch (error) {
			console.error("Failed to initialize memory store:", error);
		}
	}

	async get(key: string): Promise<MemoryEntry | undefined> {
		return this.cache.get(key);
	}

	async set(entry: MemoryEntry): Promise<void> {
		this.cache.set(entry.key, entry);
		await this.saveToDisk();
	}

	async delete(key: string): Promise<boolean> {
		const deleted = this.cache.delete(key);
		if (deleted) {
			await this.saveToDisk();
		}
		return deleted;
	}

	async list(type?: string): Promise<MemoryEntry[]> {
		const entries = Array.from(this.cache.values());
		if (type) {
			return entries.filter((e) => e.type === type);
		}
		return entries;
	}

	async search(query: string): Promise<MemoryEntry[]> {
		const entries = Array.from(this.cache.values());
		const lowerQuery = query.toLowerCase();

		return entries.filter(
			(entry) =>
				entry.key.toLowerCase().includes(lowerQuery) ||
				entry.value.toLowerCase().includes(lowerQuery),
		);
	}

	async clear(): Promise<void> {
		this.cache.clear();
		await this.saveToDisk();
	}

	private async loadFromDisk(): Promise<void> {
		try {
			const files = await fs.readdir(this.basePath);

			for (const file of files) {
				if (file.endsWith(".json")) {
					const filePath = path.join(this.basePath, file);
					const content = await fs.readFile(filePath, "utf-8");
					const entry = JSON.parse(content) as MemoryEntry;
					this.cache.set(entry.key, entry);
				}
			}
		} catch {
			// Directory might not exist yet
		}
	}

	private async saveToDisk(): Promise<void> {
		try {
			await fs.mkdir(this.basePath, { recursive: true });

			for (const [key, entry] of Array.from(this.cache)) {
				const filePath = path.join(
					this.basePath,
					`${this.sanitizeKey(key)}.json`,
				);
				await fs.writeFile(filePath, JSON.stringify(entry, null, 2));
			}
		} catch (error) {
			console.error("Failed to save memory to disk:", error);
		}
	}

	private sanitizeKey(key: string): string {
		return key.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 100);
	}
}
