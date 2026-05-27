import type { ChatMessage } from "../types/common";
import type {
	ContextOptimizeRequest,
	ContextOptimizeResult,
	IContextManager,
	KeyInfo,
	TaskState,
} from "../types/context";
import { countMessagesTokens } from "../utils/token-counter";
import { KeyInfoExtractor } from "./KeyInfoExtractor";
import { MessageFolder } from "./MessageFolder";
import { SummaryGenerator } from "./SummaryGenerator";

export interface ContextManagerOptions {
	foldThreshold?: number;
	aggressiveThreshold?: number;
	tailFraction?: number;
}

export class ContextManager implements IContextManager {
	private keyInfoExtractor: KeyInfoExtractor;
	private messageFolder: MessageFolder;
	private summaryGenerator: SummaryGenerator;

	private foldThreshold: number;
	private aggressiveThreshold: number;
	private tailFraction: number;

	constructor(options?: ContextManagerOptions) {
		this.keyInfoExtractor = new KeyInfoExtractor();
		this.messageFolder = new MessageFolder();
		this.summaryGenerator = new SummaryGenerator();

		this.foldThreshold = options?.foldThreshold ?? 0.7;
		this.aggressiveThreshold = options?.aggressiveThreshold ?? 0.75;
		this.tailFraction = options?.tailFraction ?? 0.25;
	}

	async optimize(
		request: ContextOptimizeRequest,
	): Promise<ContextOptimizeResult> {
		const currentTokens =
			request.currentTokens || this.countTokens(request.messages);
		const ratio = currentTokens / request.maxTokens;

		if (ratio < this.foldThreshold) {
			return {
				messages: request.messages,
				folded: false,
				originalCount: request.messages.length,
				foldedCount: request.messages.length,
				retainedInfo: null,
				tokens: {
					before: currentTokens,
					after: currentTokens,
					saved: 0,
				},
			};
		}

		const keyInfo = await this.extractKeyInfo(
			request.messages,
			request.taskState,
		);

		const isAggressive = ratio > this.aggressiveThreshold;
		const tailFraction = isAggressive ? 0.15 : this.tailFraction;

		const foldedMessages = await this.messageFolder.fold(
			request.messages,
			keyInfo,
			{
				tailFraction,
				maxTokens: request.maxTokens,
				preserveSystemMessages: true,
			},
		);

		const summaryMessage = foldedMessages.find(
			(m) => m.role === "assistant" && m.content.includes("[Context folded"),
		);

		const afterTokens = this.countTokens(foldedMessages);

		return {
			messages: foldedMessages,
			folded: true,
			originalCount: request.messages.length,
			foldedCount: foldedMessages.length,
			retainedInfo: keyInfo,
			summaryMessage,
			tokens: {
				before: currentTokens,
				after: afterTokens,
				saved: currentTokens - afterTokens,
			},
		};
	}

	async extractKeyInfo(
		messages: ChatMessage[],
		taskState: TaskState,
	): Promise<KeyInfo> {
		return this.keyInfoExtractor.extract(messages, taskState);
	}

	async generateSummary(
		messages: ChatMessage[],
		keyInfo: KeyInfo,
	): Promise<string> {
		return this.summaryGenerator.generate(messages, keyInfo);
	}

	countTokens(messages: ChatMessage[]): number {
		return countMessagesTokens(
			messages.map((m) => ({
				role: m.role,
				content: m.content,
				tool_calls: m.tool_calls,
			})),
		);
	}

	shouldFold(currentTokens: number, maxTokens: number): boolean {
		return currentTokens / maxTokens >= this.foldThreshold;
	}
}
