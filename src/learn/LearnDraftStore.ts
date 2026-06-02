import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LearnedSkillDraft } from "./types.js";

export class LearnDraftStore {
	constructor(private readonly projectRoot: string) {}

	private get draftsDir(): string {
		return path.join(this.projectRoot, ".minimum", "learn", "drafts");
	}

	async save(draft: LearnedSkillDraft): Promise<void> {
		await fs.mkdir(this.draftsDir, { recursive: true });
		await atomicWriteJson(path.join(this.draftsDir, `${draft.id}.json`), draft);
	}

	async read(id: string): Promise<LearnedSkillDraft> {
		const raw = await fs.readFile(path.join(this.draftsDir, `${id}.json`), "utf-8");
		return JSON.parse(raw) as LearnedSkillDraft;
	}

	async list(): Promise<LearnedSkillDraft[]> {
		try {
			const entries = await fs.readdir(this.draftsDir, { withFileTypes: true });
			const drafts: LearnedSkillDraft[] = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				const raw = await fs.readFile(path.join(this.draftsDir, entry.name), "utf-8");
				drafts.push(JSON.parse(raw) as LearnedSkillDraft);
			}
			return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		} catch {
			return [];
		}
	}
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	await fs.rename(tmp, filePath);
}
