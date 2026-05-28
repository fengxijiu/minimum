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

/**
 * 计算消息列表的token数
 */
export function countMessagesTokens(
	messages: Array<{ role: string; content: string; tool_calls?: any[] }>,
): number {
	let total = 0;

	for (const msg of messages) {
		// 消息开销
		total += 4;

		// 角色
		total += estimateTokens(msg.role);

		// 内容
		if (msg.content) {
			total += estimateTokens(msg.content);
		}

		// 工具调用
		if (msg.tool_calls) {
			total += estimateTokens(JSON.stringify(msg.tool_calls));
		}
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
