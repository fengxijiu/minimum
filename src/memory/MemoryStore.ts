import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getGlobalMemoryRoot, sanitizeMemoryKey } from "./single/MemoryPaths.js";

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

interface MemoryStoreIndex {
	version: number;
	updatedAt: string;
	entries: Array<{
		key: string;
		type: MemoryEntry["type"];
		path: string;
		timestamp: number;
		metadata?: Record<string, any>;
	}>;
}

export class MemoryStore {
	private basePath: string;
	private maxSize: number;
	private cache: Map<string, MemoryEntry> = new Map();

	constructor(options: MemoryStoreOptions = {}) {
		this.basePath = options.basePath || getGlobalMemoryRoot();
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
			await fs.rm(this.fileForKey(key), { force: true });
			await fs.rm(path.join(this.basePath, `${this.legacySanitizeKey(key)}.json`), {
				force: true,
			});
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
				const filePath = path.join(this.basePath, file);
				if (file.endsWith(".md")) {
					const content = await fs.readFile(filePath, "utf-8");
					const entry = this.parseMarkdownEntry(content, file);
					this.cache.set(entry.key, entry);
				}
			}

			for (const file of files) {
				if (!file.endsWith(".json") || file === "index.json") continue;
				const filePath = path.join(this.basePath, file);
				const content = await fs.readFile(filePath, "utf-8");
				const entry = JSON.parse(content) as MemoryEntry;
				if (!this.cache.has(entry.key)) this.cache.set(entry.key, entry);
			}
		} catch {
			// Directory might not exist yet
		}
	}

	private async saveToDisk(): Promise<void> {
		try {
			await fs.mkdir(this.basePath, { recursive: true });

			for (const entry of Array.from(this.cache.values())) {
				await fs.writeFile(this.fileForKey(entry.key), this.renderMarkdownEntry(entry));
			}
			await fs.writeFile(
				this.indexPath(),
				`${JSON.stringify(this.buildIndex(), null, 2)}\n`,
			);
		} catch (error) {
			console.error("Failed to save memory to disk:", error);
		}
	}

	private fileForKey(key: string): string {
		return path.join(this.basePath, `${sanitizeMemoryKey(key)}.md`);
	}

	private indexPath(): string {
		return path.join(this.basePath, "index.json");
	}

	private buildIndex(): MemoryStoreIndex {
		return {
			version: 1,
			updatedAt: new Date().toISOString(),
			entries: Array.from(this.cache.values()).map((entry) => ({
				key: entry.key,
				type: entry.type,
				path: `${sanitizeMemoryKey(entry.key)}.md`,
				timestamp: entry.timestamp,
				...(entry.metadata && { metadata: entry.metadata }),
			})),
		};
	}

	private renderMarkdownEntry(entry: MemoryEntry): string {
		const metadata = entry.metadata
			? `metadata: ${JSON.stringify(entry.metadata)}\n`
			: "";
		return [
			"---",
			`key: ${JSON.stringify(entry.key)}`,
			`type: ${entry.type}`,
			`timestamp: ${entry.timestamp}`,
			metadata.trimEnd(),
			"---",
			"",
			entry.value.trimEnd(),
			"",
		]
			.filter((line, index) => line !== "" || index > 4)
			.join("\n");
	}

	private parseMarkdownEntry(content: string, fileName: string): MemoryEntry {
		const fallbackKey = fileName.replace(/\.md$/i, "");
		if (!content.startsWith("---\n")) {
			return {
				key: fallbackKey,
				value: content.trim(),
				type: "user",
				timestamp: 0,
			};
		}
		const end = content.indexOf("\n---\n", 4);
		if (end === -1) {
			return {
				key: fallbackKey,
				value: content.trim(),
				type: "user",
				timestamp: 0,
			};
		}
		const frontmatter = content.slice(4, end).split(/\r?\n/);
		const body = content.slice(end + 5).trim();
		const data: Record<string, string> = {};
		for (const line of frontmatter) {
			const [rawKey, ...rawValue] = line.split(":");
			if (!rawKey || rawValue.length === 0) continue;
			data[rawKey.trim()] = rawValue.join(":").trim();
		}
		return {
			key: data.key ? (JSON.parse(data.key) as string) : fallbackKey,
			value: body,
			type: isMemoryType(data.type) ? data.type : "user",
			timestamp: Number(data.timestamp) || 0,
			...(data.metadata && { metadata: JSON.parse(data.metadata) }),
		};
	}

	private legacySanitizeKey(key: string): string {
		return key.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 100);
	}
}

function isMemoryType(value: string | undefined): value is MemoryEntry["type"] {
	return value === "user" || value === "project" || value === "session";
}
