import * as path from "node:path";

/**
 * 规范化路径
 */
export function normalizePath(pathStr: string): string {
	return path.normalize(pathStr).replace(/\\/g, "/");
}

/**
 * 将相对路径转为绝对路径
 */
export function toAbsolutePath(pathStr: string, basePath: string): string {
	if (path.isAbsolute(pathStr)) {
		return normalizePath(pathStr);
	}
	return normalizePath(path.resolve(basePath, pathStr));
}

/**
 * 检查路径是否在目录内
 */
export function isPathInside(pathStr: string, directory: string): boolean {
	const normalizedPath = normalizePath(pathStr);
	const normalizedDir = normalizePath(directory);
	return (
		normalizedPath.startsWith(`${normalizedDir}/`) ||
		normalizedPath === normalizedDir
	);
}

/**
 * 获取文件扩展名
 */
export function getExtension(filePath: string): string {
	return path.extname(filePath).toLowerCase();
}

/**
 * 检测编程语言
 */
export function detectLanguage(filePath: string): string {
	const ext = getExtension(filePath);
	const languageMap: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".py": "python",
		".rs": "rust",
		".go": "go",
		".java": "java",
		".c": "c",
		".cpp": "cpp",
		".h": "c",
		".hpp": "cpp",
		".rb": "ruby",
		".php": "php",
		".swift": "swift",
		".kt": "kotlin",
		".scala": "scala",
		".sh": "bash",
		".bash": "bash",
		".zsh": "zsh",
		".sql": "sql",
		".html": "html",
		".css": "css",
		".scss": "scss",
		".less": "less",
		".json": "json",
		".yaml": "yaml",
		".yml": "yaml",
		".xml": "xml",
		".md": "markdown",
		".rst": "rst",
		".txt": "text",
	};
	return languageMap[ext] || "unknown";
}
