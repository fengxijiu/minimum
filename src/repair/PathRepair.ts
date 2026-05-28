import type { RepairContext } from "../types/repair.js";
import {
	isPathInside,
	normalizePath,
	toAbsolutePath,
} from "../utils/path-utils.js";

export class PathRepair {
	repair(pathStr: string, context: RepairContext): string {
		if (!pathStr) return pathStr;

		// 规范化路径
		let repaired = normalizePath(pathStr);

		// 如果是相对路径，转为绝对路径
		if (!repaired.startsWith("/")) {
			repaired = toAbsolutePath(repaired, context.workingDirectory);
		}

		// 检查路径是否在项目内
		if (!isPathInside(repaired, context.projectRoot)) {
			// 如果不在项目内，调整到项目内
			repaired = `${context.projectRoot}/${pathStr}`;
			repaired = normalizePath(repaired);
		}

		return repaired;
	}
}
