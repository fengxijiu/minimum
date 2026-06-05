import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PlanDraft } from "./types.js";

const SAFE_DRAFT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class PlanDraftStore {
	constructor(private readonly projectRoot: string) {}

	private get draftsDir(): string {
		return path.join(this.projectRoot, ".minimum", "plans", "drafts");
	}

	async save(draft: PlanDraft): Promise<void> {
		assertSafeDraftId(draft.id);
		await fs.mkdir(this.draftsDir, { recursive: true });
		await atomicWriteJson(path.join(this.draftsDir, `${draft.id}.json`), draft);
	}

	async readRaw(id: string): Promise<unknown> {
		assertSafeDraftId(id);
		const raw = await fs.readFile(path.join(this.draftsDir, `${id}.json`), "utf-8");
		return JSON.parse(raw) as unknown;
	}

	async listRaw(): Promise<Array<{ id: string; raw: unknown }>> {
		try {
			const entries = await fs.readdir(this.draftsDir, { withFileTypes: true });
			const drafts: Array<{ id: string; raw: unknown }> = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				const id = entry.name.slice(0, -".json".length);
				if (!SAFE_DRAFT_ID.test(id)) continue;
				const raw = await fs.readFile(path.join(this.draftsDir, entry.name), "utf-8");
				drafts.push({ id, raw: JSON.parse(raw) as unknown });
			}
			return drafts;
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

export function assertSafeDraftId(id: string): void {
	if (!SAFE_DRAFT_ID.test(id)) {
		throw new Error(`invalid draft id: ${id}`);
	}
}
