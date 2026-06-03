import path from "node:path";
import type { ToolCall } from "../types/common.js";

/**
 * ReadTracker - 强制"先读后写"，防止 MiMo 盲改文件导致的 Code Defect。
 *
 * 参考 DeepSeek-Reasonix / CodeWhale：编辑工具执行前，目标文件必须先被读过。
 * 按解析后的绝对路径去重记录，避免相对路径与工作目录差异造成漏判。
 */
export class ReadTracker {
	private readPaths = new Set<string>();

	private resolvePath(rawPath: string, workingDirectory?: string): string {
		if (!rawPath) return "";
		return workingDirectory
			? path.resolve(workingDirectory, rawPath)
			: path.resolve(rawPath);
	}

	markRead(rawPath: string, workingDirectory?: string): void {
		const resolved = this.resolvePath(rawPath, workingDirectory);
		if (resolved) {
			this.readPaths.add(resolved);
		}
	}

	hasRead(rawPath: string, workingDirectory?: string): boolean {
		const resolved = this.resolvePath(rawPath, workingDirectory);
		return resolved ? this.readPaths.has(resolved) : false;
	}

	/**
	 * 编辑前的守卫。未读返回拦截原因，已读返回 null。
	 */
	guardEdit(rawPath: string, workingDirectory?: string): string | null {
		if (!rawPath) return null;
		if (this.hasRead(rawPath, workingDirectory)) {
			return null;
		}
		return `File ${rawPath} has not been read yet. Read it with read_file before editing to avoid blind modifications.`;
	}

	reset(): void {
		this.readPaths.clear();
	}
}

const READ_TOOLS = new Set(["read_file"]);
// apply_patch is a third edit path (search/replace hunks) — must trip the
// read-before-edit guard alongside edit_file/write_file or the model can
// blind-patch files it never read.
const EDIT_TOOLS = new Set(["edit_file", "write_file", "apply_patch"]);

export function isReadTool(call: ToolCall): boolean {
	return READ_TOOLS.has(call.function.name);
}

export function isEditTool(call: ToolCall): boolean {
	return EDIT_TOOLS.has(call.function.name);
}
