export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	activeForm: string;
}

const MARK = {
	completed: "[x]",
	in_progress: "[>]",
	pending: "[ ]",
} as const;

function validateTodos(raw: unknown): TodoItem[] | string {
	if (!Array.isArray(raw)) return "todo_write: `todos` must be an array";
	const out: TodoItem[] = [];
	let inProgress = 0;
	for (let i = 0; i < raw.length; i++) {
		const e = raw[i];
		if (!e || typeof e !== "object") return `todo_write: todo #${i + 1} must be an object`;
		const obj = e as Record<string, unknown>;
		const content = typeof obj.content === "string" ? obj.content.trim() : "";
		const activeForm = typeof obj.activeForm === "string" ? obj.activeForm.trim() : "";
		const status = obj.status;
		if (!content) return `todo_write: todo #${i + 1} \`content\` must be a non-empty string`;
		if (!activeForm) return `todo_write: todo #${i + 1} \`activeForm\` must be a non-empty string`;
		if (status !== "pending" && status !== "in_progress" && status !== "completed") {
			return `todo_write: todo #${i + 1} \`status\` must be one of pending|in_progress|completed (got ${JSON.stringify(status)})`;
		}
		if (status === "in_progress") {
			inProgress++;
			if (inProgress > 1) {
				return "todo_write: at most one todo may be in_progress at a time — mark the previous one completed first";
			}
		}
		out.push({ content, status, activeForm });
	}
	return out;
}

/**
 * TodoWriteTool — 会话内可见待办,set 语义(每次调用替换整张列表)。
 * 至多一个 in_progress;in_progress 项渲染 activeForm,其它渲染 content。
 */
export class TodoWriteTool {
	name = "todo_write";
	description =
		"In-session task tracker for 3+ step work. Each call REPLACES the entire list (set semantics) — pass the FULL list. Exactly one item may be in_progress at a time; flip to completed the moment that step's done. Pass `[]` to clear.";

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
						description: "The COMPLETE new todo list. Replaces the previous one. Pass [] to clear.",
						items: {
							type: "object",
							properties: {
								content: {
									type: "string",
									description: "Imperative step description, e.g. \"Add tests for parser\".",
								},
								status: {
									type: "string",
									enum: ["pending", "in_progress", "completed"],
									description: "Current state. Exactly one item may be in_progress.",
								},
								activeForm: {
									type: "string",
									description: "Gerund form shown while in_progress, e.g. \"Adding tests for parser\".",
								},
							},
							required: ["content", "status", "activeForm"],
						},
					},
				},
				required: ["todos"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const validated = validateTodos(args?.todos);
		if (typeof validated === "string") return `Error: ${validated}`;
		this.todos = validated;
		if (this.todos.length === 0) return "Todo list cleared.";

		let done = 0;
		let active = 0;
		let pending = 0;
		for (const t of this.todos) {
			if (t.status === "completed") done++;
			else if (t.status === "in_progress") active++;
			else pending++;
		}
		const header = `Todos (${done}/${this.todos.length} done · ${active} in progress · ${pending} pending):`;
		const lines = this.todos.map((t) => {
			if (t.status === "in_progress") return `${MARK.in_progress} ${t.activeForm}`;
			return `${MARK[t.status]} ${t.content}`;
		});
		return `${header}\n${lines.join("\n")}`;
	}

	getTodos(): TodoItem[] {
		return [...this.todos];
	}
}
