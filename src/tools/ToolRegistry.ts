import type { ToolDefinition } from "../types/common.js";
import { truncateToolResult } from "./truncateResult.js";

export interface Tool {
	name: string;
	description: string;
	getDefinition(): ToolDefinition;
	execute(args: Record<string, any>, context?: any): Promise<string>;
}

export interface ToolCallContext {
	signal?: AbortSignal;
	workingDirectory?: string;
}

export class ToolRegistry {
	private tools: Map<string, Tool> = new Map();

	register(tool: Tool): void {
		this.tools.set(tool.name, tool);
	}

	unregister(name: string): boolean {
		return this.tools.delete(name);
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	getAll(): Tool[] {
		return Array.from(this.tools.values());
	}

	getDefinitions(): ToolDefinition[] {
		return Array.from(this.tools.values()).map((tool) => tool.getDefinition());
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	async execute(
		toolCall: { function: { name: string; arguments: string } },
		context?: ToolCallContext,
	): Promise<{ content: string; isError?: boolean }> {
		const tool = this.tools.get(toolCall.function.name);

		if (!tool) {
			return {
				content: `Unknown tool: ${toolCall.function.name}`,
				isError: true,
			};
		}

		let args: Record<string, unknown>;
		try {
			args = JSON.parse(toolCall.function.arguments || '{}');
		} catch {
			return {
				content: [
					`工具 "${toolCall.function.name}" 调用失败`,
					`错误: 参数 JSON 解析失败`,
					`原始参数: ${toolCall.function.arguments?.slice(0, 200)}`,
					`提示: 检查参数格式是否为合法 JSON`,
				].join('\n'),
				isError: true,
			};
		}

		try {
			const raw = await tool.execute(args, context);
			return { content: truncateToolResult(raw, undefined, toolCall.function.name) };
		} catch (error: any) {
			const code: string = error.code ?? '';
			const hint =
				code === 'ENOENT' ? '文件或目录不存在，请检查路径' :
				code === 'EACCES' || code === 'EPERM' ? '权限被拒绝，检查文件权限' :
				code === 'EISDIR' ? '路径指向目录而非文件' :
				code === 'ENOTDIR' ? '路径中某部分不是目录' :
				code === 'EEXIST' ? '文件已存在' :
				/timeout/i.test(error.message) ? '命令超时，考虑增大 timeout 参数或拆分任务' :
				'';
			return {
				content: [
					`工具 "${toolCall.function.name}" 执行失败`,
					`错误: ${error.message}`,
					hint && `提示: ${hint}`,
				].filter(Boolean).join('\n'),
				isError: true,
			};
		}
	}
}
