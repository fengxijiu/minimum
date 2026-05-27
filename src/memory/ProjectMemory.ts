import * as path from "path";
import * as fs from "fs/promises";

export interface ProjectMemoryEntry {
	key: string;
	value: string;
	description?: string;
	createdAt: number;
	updatedAt: number;
}

export class ProjectMemory {
	private projectRoot: string;
	private memoryPath: string;
	private entries: Map<string, ProjectMemoryEntry> = new Map();

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.memoryPath = path.join(projectRoot, ".minimum", "memory.json");
	}

	async initialize(): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });
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
			description,
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
		try {
			const content = await fs.readFile(this.memoryPath, "utf-8");
			const data = JSON.parse(content);

			for (const entry of data.entries || []) {
				this.entries.set(entry.key, entry);
			}
		} catch {
			// File might not exist
		}
	}

	private async save(): Promise<void> {
		const data = {
			projectRoot: this.projectRoot,
			entries: Array.from(this.entries.values()),
			updatedAt: Date.now(),
		};

		await fs.writeFile(this.memoryPath, JSON.stringify(data, null, 2));
	}
}
