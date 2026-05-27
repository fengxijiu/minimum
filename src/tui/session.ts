import * as fs from "fs/promises";
import * as path from "path";

export interface PersistedCard {
	id: string;
	kind: string;
	text: string;
	status?: string;
	timestamp: number;
}

export interface PersistedSession {
	name: string;
	createdAt: string;
	updatedAt: string;
	workingDirectory: string;
	cards: PersistedCard[];
}

export function sessionDir(root = process.cwd()): string {
	return path.join(root, ".minimum", "sessions");
}

export async function saveSession(
	name: string,
	cards: PersistedCard[],
	root = process.cwd(),
): Promise<string> {
	const dir = sessionDir(root);
	await fs.mkdir(dir, { recursive: true });
	const now = new Date().toISOString();
	const file = path.join(dir, `${sanitizeName(name)}.json`);
	const previous = await loadSession(name, root).catch(() => null);
	const payload: PersistedSession = {
		name,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		workingDirectory: root,
		cards,
	};
	await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf-8");
	return file;
}

export async function loadSession(
	name: string,
	root = process.cwd(),
): Promise<PersistedSession> {
	const file = path.join(sessionDir(root), `${sanitizeName(name)}.json`);
	const content = await fs.readFile(file, "utf-8");
	return JSON.parse(content) as PersistedSession;
}

export async function listSessions(root = process.cwd()): Promise<string[]> {
	let files: string[];
	try {
		files = await fs.readdir(sessionDir(root));
	} catch {
		return [];
	}
	return files
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.slice(0, -5))
		.sort();
}

function sanitizeName(name: string): string {
	return name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-") || "default";
}
