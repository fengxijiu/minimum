/** Default cap: 32 KB per tool result — matches Claude Code's default context budget per result. */
export const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;

/**
 * Truncate a tool result to stay within the context budget.
 * Appends a clear marker so the model knows data was clipped and how to get more.
 */
export function truncateToolResult(
	content: string,
	maxBytes = DEFAULT_MAX_RESULT_BYTES,
	toolName?: string,
): string {
	const totalBytes = Buffer.byteLength(content, "utf8");
	if (totalBytes <= maxBytes) return content;

	// Slice to maxBytes on a UTF-8 boundary
	const buf = Buffer.from(content, "utf8").subarray(0, maxBytes);
	let truncated = buf.toString("utf8");

	// Don't leave a half-line at the end
	const lastNewline = truncated.lastIndexOf("\n");
	if (lastNewline > maxBytes * 0.8) {
		truncated = truncated.slice(0, lastNewline);
	}

	const shownKb = Math.round(Buffer.byteLength(truncated, "utf8") / 1024);
	const totalKb = Math.round(totalBytes / 1024);
	const hint =
		toolName === "read_file"
			? "使用 startLine/endLine 参数读取其余部分"
			: "若需完整内容，缩小查询范围或分批获取";

	return `${truncated}\n\n[输出已截断：已显示 ${shownKb} KB / 共 ${totalKb} KB。${hint}]`;
}
