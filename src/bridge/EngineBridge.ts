import type { ApprovalManager } from "../approval/ApprovalManager.js";
import type {
	ApprovalMode,
	ApprovalRequest,
	ApprovalResponse,
} from "../approval/types.js";
import type { LoopEvent } from "../loop/MiMoLoop.js";

/**
 * UiEvent — 前端无关的规范化事件流。
 *
 * MiMoLoop 的 LoopEvent 偏引擎内部；UiEvent 是给任意前端（Ink TUI / web /
 * headless）消费的稳定契约。EngineBridge 负责两者的翻译，这样 TUI 不必关心
 * 引擎内部事件的演进。参考 OpenCode 的「单一事件流，多前端共用」。
 */
export type UiPlanStatus = "pending" | "in_progress" | "completed";
export interface UiPlanStep {
	label: string;
	status: UiPlanStatus;
}

export type UiRisk = "low" | "medium" | "high";

export type UiEvent =
	| { kind: "assistant"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "tool"; name: string; args: string }
	| { kind: "tool_result"; name: string; ok: boolean; content: string }
	| { kind: "notice"; text: string; tone: "info" | "warn" | "ok" }
	| { kind: "error"; text: string }
	| {
			kind: "usage";
			totalTokens: number;
			toolCalls: number;
			steps: number;
			totalCostUsd: number;
	  }
	| { kind: "plan"; steps: UiPlanStep[] }
	| {
			kind: "permission_request";
			id: string;
			tool: string;
			args: Record<string, unknown>;
			risk: UiRisk;
			description: string;
	  }
	| {
			/** Pipeline (orchestrator) phase transition for the W0–W4 panel, including W3.5. */
			kind: "pipeline";
			phase: string;
			label: string;
			detail?: string;
	  }
	| { kind: "done"; success: boolean }
	| { kind: "streaming"; text: string }
	| { kind: "streaming_reasoning"; text: string }
	| { kind: "streaming_start" }
	| { kind: "streaming_end" };

/** Parse TodoWriteTool's formatted result back into structured plan steps. */
export function parsePlanFromTodoResult(content: string): UiPlanStep[] | null {
	const steps: UiPlanStep[] = [];
	for (const raw of content.split("\n")) {
		const m = raw.match(/^\[([ ~x])\]\s+(.+)$/);
		if (!m) continue;
		const mark = m[1];
		const label = m[2];
		if (!label) continue;
		const status: UiPlanStatus =
			mark === " " ? "pending" : mark === "~" ? "in_progress" : "completed";
		steps.push({ label, status });
	}
	return steps.length ? steps : null;
}

export interface EngineLoop {
	run(userInput: string): AsyncGenerator<LoopEvent>;
	getMessages?(): import("../types/common.js").ChatMessage[];
	loadHistory?(messages: import("../types/common.js").ChatMessage[]): void;
}

/** Translate a single engine event into zero or one UI events. */
export function mapLoopEvent(e: LoopEvent): UiEvent | null {
	switch (e.type) {
		case "content":
			return { kind: "assistant", text: e.content };
		case "reasoning":
			return { kind: "reasoning", text: e.content };
		case "tool_call":
			return {
				kind: "tool",
				name: e.toolCall.function.name,
				args: e.toolCall.function.arguments || "",
			};
		case "tool_result":
			return {
				kind: "tool_result",
				name: e.toolCall.function.name,
				ok: e.success,
				content: typeof e.result?.content === "string" ? e.result.content : "",
			};
		case "validation":
			return e.result?.passed
				? null
				: { kind: "notice", text: "validation failed", tone: "warn" };
		case "completeness":
			return e.result?.complete
				? null
				: {
						kind: "notice",
						text: "incomplete — agent will continue",
						tone: "warn",
					};
		case "context_optimized":
			return e.result?.folded
				? { kind: "notice", text: "context folded", tone: "info" }
				: null;
		case "capacity":
			return e.snapshot.action === "no_intervention"
				? null
				: {
						kind: "notice",
						text: `capacity: ${e.snapshot.action}`,
						tone: "warn",
					};
		case "hook":
			return { kind: "notice", text: `hook · ${e.event}`, tone: "info" };
		case "plan_blocked":
			return {
				kind: "notice",
				text: `plan mode blocked ${e.toolCall.function.name}`,
				tone: "warn",
			};
		case "iteration":
			return {
				kind: "notice",
				text: `retry ${e.attempt}/${e.maxAttempts}`,
				tone: "info",
			};
		case "steer_accepted":
			return { kind: "notice", text: `steer: ${e.content}`, tone: "info" };
		case "usage":
			return {
				kind: "usage",
				totalTokens: e.usage?.totalTokens ?? 0,
				toolCalls: e.usage?.toolCalls ?? 0,
				steps: e.usage?.steps ?? 0,
				totalCostUsd: e.usage?.totalCostUsd ?? 0,
			};
		case "error":
			return { kind: "error", text: e.error };
		case "done":
			return { kind: "done", success: e.success };
		default:
			return null;
	}
}

/**
 * EngineBridge — 把一个 MiMoLoop（或兼容对象）包成规范化事件流。
 *
 * 可选 `approvalManager`：注入后 Bridge 会把交互式权限请求转成
 * `permission_request` UiEvent 推给前端，并等待 `resolvePermission` 回填。
 */
export class EngineBridge {
	private pending = new Map<string, (r: ApprovalResponse) => void>();
	private queue: UiEvent[] = [];
	private notifier?: () => void;

	constructor(
		private loop: EngineLoop,
		opts?: { approvalManager?: ApprovalManager },
	) {
		opts?.approvalManager?.setPrompter(async (req) => this.askUser(req));
	}

	getHistory(): import("../types/common.js").ChatMessage[] {
		return this.loop.getMessages?.() ?? [];
	}

	loadHistory(messages: import("../types/common.js").ChatMessage[]): void {
		this.loop.loadHistory?.(messages);
	}

	/** Forward an approval decision from the frontend back into the engine. */
	resolvePermission(id: string, response: ApprovalResponse): void {
		const resolve = this.pending.get(id);
		if (resolve) {
			this.pending.delete(id);
			resolve(response);
		}
	}

	private askUser(req: ApprovalRequest): Promise<ApprovalResponse> {
		return new Promise<ApprovalResponse>((resolve) => {
			this.pending.set(req.id, resolve);
			this.queue.push({
				kind: "permission_request",
				id: req.id,
				tool: req.tool,
				args: req.args,
				risk: req.risk,
				description: req.description,
			});
			this.notifier?.();
		});
	}

	async *send(userInput: string): AsyncGenerator<UiEvent> {
		const loopIter = this.loop.run(userInput)[Symbol.asyncIterator]();
		let pendingLoop: Promise<IteratorResult<LoopEvent>> | null = null;
		let loopDone = false;

		while (true) {
			while (this.queue.length) yield this.queue.shift()!;
			if (loopDone) break;

			if (!pendingLoop) pendingLoop = loopIter.next();
			const queueWait = new Promise<"queue">((r) => {
				this.notifier = () => {
					this.notifier = undefined;
					r("queue");
				};
			});
			const winner = await Promise.race([
				pendingLoop.then(() => "loop" as const),
				queueWait,
			]);
			this.notifier = undefined;
			if (winner === "queue") continue;

			const result = await pendingLoop;
			pendingLoop = null;
			if (result.done) {
				loopDone = true;
				continue;
			}
			const e = result.value;
			const ui = mapLoopEvent(e);
			if (ui) yield ui;
			if (
				e.type === "tool_result" &&
				e.success &&
				e.toolCall.function.name === "todo_write"
			) {
				const content =
					typeof e.result?.content === "string" ? e.result.content : "";
				const steps = parsePlanFromTodoResult(content);
				if (steps) yield { kind: "plan", steps };
			}
		}
	}
}

export type { ApprovalMode };
