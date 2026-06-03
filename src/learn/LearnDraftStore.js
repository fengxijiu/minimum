import * as fs from "node:fs/promises";
import * as path from "node:path";
export class LearnDraftStore {
    projectRoot;
    constructor(projectRoot) {
        this.projectRoot = projectRoot;
    }
    get draftsDir() {
        return path.join(this.projectRoot, ".minimum", "learn", "drafts");
    }
    async save(draft) {
        await fs.mkdir(this.draftsDir, { recursive: true });
        await atomicWriteJson(path.join(this.draftsDir, `${draft.id}.json`), draft);
    }
    async read(id) {
        const raw = await fs.readFile(path.join(this.draftsDir, `${id}.json`), "utf-8");
        return JSON.parse(raw);
    }
    async list() {
        try {
            const entries = await fs.readdir(this.draftsDir, { withFileTypes: true });
            const drafts = [];
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith(".json"))
                    continue;
                const raw = await fs.readFile(path.join(this.draftsDir, entry.name), "utf-8");
                drafts.push(JSON.parse(raw));
            }
            return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        }
        catch {
            return [];
        }
    }
}
export async function atomicWriteJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await fs.rename(tmp, filePath);
}
