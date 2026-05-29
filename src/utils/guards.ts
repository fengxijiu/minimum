/** Narrow an unknown to a plain object (not null, not an array). */
export function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type JsonBlockResult =
	| { ok: true; value: unknown; raw: string }
	| { ok: false; error: string; raw?: string };

/**
 * Extract a single `<tag>...</tag>` block and JSON.parse its contents.
 *
 * Shared by the master_planner compilers (task_dag / refine / finalize), which
 * all wrap a JSON payload in a named XML tag. Returns a discriminated result so
 * each caller can run its own structural validation on `value`.
 */
export function extractJsonBlock(text: string, tag: string): JsonBlockResult {
	const m = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
	if (!m) return { ok: false, error: `missing <${tag}> block` };
	const raw = m[1]!;
	try {
		return { ok: true, value: JSON.parse(raw), raw };
	} catch (e) {
		return {
			ok: false,
			error: `invalid JSON in <${tag}>: ${String((e as Error).message)}`,
			raw,
		};
	}
}
