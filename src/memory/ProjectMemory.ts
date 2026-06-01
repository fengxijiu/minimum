import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getMemoryFile,
	getMemoryIndexPath,
	getProjectMemoryRoot,
	projectMemoryLayer,
	sanitizeMemoryKey,
} from "./single/MemoryPaths.js";

export interface ProjectMemoryEntry {
	key: string;
	value: string;
	description?: string;
	createdAt: number;
	updatedAt: number;
}

interface ProjectMemoryIndex {
	version: number;
	projectRoot: string;
	updatedAt: number;
	entries: Array<{
		key: string;
		path: string;
		description?: string;
		createdAt: number;
		updatedAt: number;
	}>;
}

export class ProjectMemory {
	private projectRoot: string;
	private memoryPath: string;
	private legacyMemoryPath: string;
	private entries: Map<string, ProjectMemoryEntry> = new Map();

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.memoryPath = getProjectMemoryRoot(projectRoot);
		this.legacyMemoryPath = path.join(projectRoot, ".minimum", "memory.json");
	}

	async initialize(): Promise<void> {
		try {
			await fs.mkdir(this.memoryPath, { recursive: true });
			await this.load();
		} catch {
			// File might not exist yet
		}
	}

	async get(key: string): Promise<ProjectMemoryEntry | undefined> {
		return this.entries.get(key);
	}

	async set(key: string, value: string, description?: string): Promise<void> {
		const entry: ProjectMemoryEntry = {
			key,
			value,
			...(description && { description }),
			createdAt: this.entries.get(key)?.createdAt || Date.now(),
			updatedAt: Date.now(),
		};

		this.entries.set(key, entry);
		await this.save();
	}

	async delete(key: string): Promise<boolean> {
		const deleted = this.entries.delete(key);
		if (deleted) {
			await this.save();
			await fs.rm(this.fileForKey(key), { force: true });
		}
		return deleted;
	}

	async list(): Promise<ProjectMemoryEntry[]> {
		return Array.from(this.entries.values());
	}

	async search(query: string): Promise<ProjectMemoryEntry[]> {
		const lowerQuery = query.toLowerCase();
		return Array.from(this.entries.values()).filter(
			(entry) =>
				entry.key.toLowerCase().includes(lowerQuery) ||
				entry.value.toLowerCase().includes(lowerQuery),
		);
	}

	private async load(): Promise<void> {
		await this.loadMarkdownEntries();
		await this.loadLegacyJsonEntries();
	}

	private async loadMarkdownEntries(): Promise<void> {
		try {
			const files = await fs.readdir(this.memoryPath);
			for (const file of files) {
				if (!file.endsWith(".md")) continue;
				const content = await fs.readFile(path.join(this.memoryPath, file), "utf-8");
				const entry = this.parseMarkdownEntry(content, file);
				this.entries.set(entry.key, entry);
			}
		} catch {
			// Directory might not exist yet
		}
	}

	private async loadLegacyJsonEntries(): Promise<void> {
		try {
			const content = await fs.readFile(this.legacyMemoryPath, "utf-8");
			const data = JSON.parse(content);

			for (const entry of data.entries || []) {
				if (!this.entries.has(entry.key)) this.entries.set(entry.key, entry);
			}
		} catch {
			// File might not exist
		}
	}

	private async save(): Promise<void> {
		await fs.mkdir(this.memoryPath, { recursive: true });
		for (const entry of Array.from(this.entries.values())) {
			await fs.writeFile(this.fileForKey(entry.key), this.renderMarkdownEntry(entry));
		}
		await fs.writeFile(
			getMemoryIndexPath(projectMemoryLayer(this.projectRoot)),
			`${JSON.stringify(this.buildIndex(), null, 2)}\n`,
		);
	}

	private fileForKey(key: string): string {
		return getMemoryFile(projectMemoryLayer(this.projectRoot), key);
	}

	private buildIndex(): ProjectMemoryIndex {
		return {
			version: 1,
			projectRoot: this.projectRoot,
			updatedAt: Date.now(),
			entries: Array.from(this.entries.values()).map((entry) => ({
				key: entry.key,
				path: `${sanitizeMemoryKey(entry.key)}.md`,
				...(entry.description && { description: entry.description }),
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
			})),
		};
	}

	private renderMarkdownEntry(entry: ProjectMemoryEntry): string {
		return [
			"---",
			`key: ${JSON.stringify(entry.key)}`,
			...(entry.description ? [`description: ${JSON.stringify(entry.description)}`] : []),
			`created_at: ${entry.createdAt}`,
			`updated_at: ${entry.updatedAt}`,
			"---",
			"",
			entry.value.trimEnd(),
			"",
		].join("\n");
	}

	private parseMarkdownEntry(
		content: string,
		fileName: string,
	): ProjectMemoryEntry {
		const fallbackKey = fileName.replace(/\.md$/i, "");
		if (!content.startsWith("---\n")) {
			return {
				key: fallbackKey,
				value: content.trim(),
				createdAt: 0,
				updatedAt: 0,
			};
		}
		const end = content.indexOf("\n---\n", 4);
		if (end === -1) {
			return {
				key: fallbackKey,
				value: content.trim(),
				createdAt: 0,
				updatedAt: 0,
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
			...(data.description && {
				description: JSON.parse(data.description) as string,
			}),
			createdAt: Number(data.created_at) || 0,
			updatedAt: Number(data.updated_at) || 0,
		};
	}
}
