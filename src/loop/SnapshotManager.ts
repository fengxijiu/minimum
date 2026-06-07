import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * SnapshotManager — 参考 CodeWhale 的 side-git 快照思路的轻量版本。
 *
 * 在 edit_file / write_file 执行前记录原始内容；若 tsc 诊断失败，
 * 调用 restore() 把文件恢复到编辑前的状态，防止脏状态在多轮迭代中叠加。
 */
export class SnapshotManager {
	private snapshots = new Map<string, string | null>();

	private resolvePath(rawPath: string, workingDirectory?: string): string {
		return workingDirectory
			? path.resolve(workingDirectory, rawPath)
			: path.resolve(rawPath);
	}

	async snapshot(rawPath: string, workingDirectory?: string): Promise<void> {
		const abs = this.resolvePath(rawPath, workingDirectory);
		if (this.snapshots.has(abs)) return;
		try {
			const content = await fs.readFile(abs, "utf-8");
			this.snapshots.set(abs, content);
		} catch {
			this.snapshots.set(abs, null);
		}
	}

	async restore(rawPath: string, workingDirectory?: string): Promise<boolean> {
		const abs = this.resolvePath(rawPath, workingDirectory);
		if (!this.snapshots.has(abs)) return false;
		const original = this.snapshots.get(abs);
		if (original === undefined) return false;
		try {
			if (original === null) {
				await fs.unlink(abs).catch(() => {});
			} else {
				await fs.writeFile(abs, original, "utf-8");
			}
			return true;
		} catch {
			return false;
		}
	}

	reset(): void {
		this.snapshots.clear();
	}
}
