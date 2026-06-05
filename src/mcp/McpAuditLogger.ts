import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface McpAuditEvent {
	projectRoot: string;
	server: string;
	kind: "tool" | "resource" | "prompt";
	name: string;
	args?: unknown;
	success: boolean;
	durationMs: number;
	error?: string;
}

export class McpAuditLogger {
	constructor(private readonly projectRoot: string) {}

	async log(event: Omit<McpAuditEvent, "projectRoot">): Promise<void> {
		const line = JSON.stringify({
			timestamp: new Date().toISOString(),
			server: event.server,
			kind: event.kind,
			name: event.name,
			args: summarizeArgs(event.args),
			success: event.success,
			durationMs: event.durationMs,
			...(event.error ? { error: redactSecrets(event.error) } : {}),
		});
		const file = path.join(this.projectRoot, ".minimum", "mcp", "audit.log");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.appendFile(file, `${line}\n`, "utf-8");
	}
}

export async function readRecentAuditEvents(projectRoot: string, limit = 100): Promise<unknown[]> {
	const file = path.join(projectRoot, ".minimum", "mcp", "audit.log");
	try {
		const raw = await fs.readFile(file, "utf-8");
		return raw
			.trim()
			.split(/\r?\n/)
			.filter(Boolean)
			.slice(-Math.max(1, limit))
			.map((line) => {
				try {
					return JSON.parse(line) as unknown;
				} catch {
					return { malformed: true, line: redactSecrets(line).slice(0, 500) };
				}
			});
	} catch {
		return [];
	}
}

export function summarizeArgs(value: unknown): unknown {
	if (value == null) return undefined;
	const redacted = redactValue(value);
	const text = JSON.stringify(redacted);
	if (text.length <= 1200) return redacted;
	return { truncated: true, preview: text.slice(0, 1200) };
}

function redactValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.slice(0, 20).map(redactValue);
	if (!value || typeof value !== "object") {
		return typeof value === "string" ? redactSecrets(value) : value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (/token|secret|password|authorization|api[_-]?key/i.test(key)) {
			out[key] = "[REDACTED]";
		} else {
			out[key] = redactValue(raw);
		}
	}
	return out;
}

export function redactSecrets(text: string): string {
	return text
		.replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]");
}
