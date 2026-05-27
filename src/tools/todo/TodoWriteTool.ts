export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

const MARK: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
};

/**
 * TodoWriteTool — 参考 Claude Code 的 TodoWrite，让 agent 在长程任务里
 * 维护一份可见的待办清单。状态随注册实例在会话内保持。
 */
export class TodoWriteTool {
	name = "todo_write";
	description =
		"Create or update the task todo list. Pass the full list each time; it replaces the previous one.";

	private todos: TodoItem[] = [];

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					todos: {
						type: "array",
						description: "The full todo list (replaces the current one)",
						items: {
							type: "object",
							properties: {
								content: { type: "string", description: "What needs doing" },
								status: {
									type: "string",
									enum: ["pending", "in_progress", "completed"],
								},
							},
							required: ["content", "status"],
						},
					},
				},
				required: ["todos"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const incoming = Array.isArray(args.todos) ? args.todos : [];
		this.todos = incoming
			.filter((t: any) => t && typeof t.content === "string")
			.map((t: any) => ({
				content: t.content,
				status: (["pending", "in_progress", "completed"].includes(t.status)
					? t.status
					: "pending") as TodoStatus,
			}));

		if (this.todos.length === 0) return "Todo list cleared.";

		const inProgress = this.todos.filter((t) => t.status === "in_progress").length;
		if (inProgress > 1) {
			return "Error: only one task may be in_progress at a time.";
		}

		const done = this.todos.filter((t) => t.status === "completed").length;
		const lines = this.todos.map((t) => `${MARK[t.status]} ${t.content}`);
		return `Todos (${done}/${this.todos.length} done):\n${lines.join("\n")}`;
	}

	getTodos(): TodoItem[] {
		return [...this.todos];
	}
}
