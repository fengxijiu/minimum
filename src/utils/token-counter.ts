/**
 * 计算文本的token数（估算）
 * 简化版本：1 token ≈ 4 characters for English, 1 token ≈ 2 characters for Chinese
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;

	// 统计中文字符数
	const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
	// 统计英文字符数（排除中文）
	const englishChars = text.length - chineseChars;

	// 估算token数
	return Math.ceil(englishChars / 4) + Math.ceil(chineseChars / 2);
}

type CountableMessage = {
	role: string;
	content: string;
	tool_calls?: any[];
	reasoning_content?: string;
};

/**
 * 按消息对象身份缓存 token 估算。
 *
 * healing / 折叠都会产生**新对象**（map / 展开），身份变化即自动失效；
 * 未改动的历史消息保持同一引用 → O(1) 命中。这样每步只对新增消息估算，
 * 整体从 O(全部字符) 降到 O(新增字符)，且与前缀缓存的命中边界天然对齐。
 */
const _msgTokenMemo = new WeakMap<object, number>();

function tokensForMessage(msg: CountableMessage): number {
	let n = _msgTokenMemo.get(msg as object);
	if (n === undefined) {
		// 消息开销 + 角色
		n = 4 + estimateTokens(msg.role);
		// 内容
		if (msg.content) n += estimateTokens(msg.content);
		// 工具调用
		if (msg.tool_calls) n += estimateTokens(JSON.stringify(msg.tool_calls));
		// 推理内容（MiMo thinking 模式强制回传，必须计入）
		if (msg.reasoning_content) n += estimateTokens(msg.reasoning_content);
		_msgTokenMemo.set(msg as object, n);
	}
	return n;
}

/**
 * 计算消息列表的token数（按对象身份增量缓存）
 */
export function countMessagesTokens(messages: CountableMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += tokensForMessage(msg);
	}
	return total;
}

/**
 * 截断文本到指定token数
 */
export function truncateToTokens(text: string, maxTokens: number): string {
	const estimatedTokens = estimateTokens(text);

	if (estimatedTokens <= maxTokens) {
		return text;
	}

	// 按比例截断
	const ratio = maxTokens / estimatedTokens;
	const targetLength = Math.floor(text.length * ratio * 0.9); // 留10%余量

	return `${text.slice(0, targetLength)}...`;
}
