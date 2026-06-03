/**
 * 计算字符串相似度（Levenshtein距离）
 */
export function levenshteinSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;

	const matrix: number[][] = [];

	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}

	for (let j = 0; j <= a.length; j++) {
		const row = matrix[0];
		if (row) row[j] = j;
	}

	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			const prevRow = matrix[i - 1];
			const currRow = matrix[i];
			if (!prevRow || !currRow) continue;

			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				currRow[j] = prevRow[j - 1] ?? 0;
			} else {
				const diag = prevRow[j - 1] ?? 0;
				const left = currRow[j - 1] ?? 0;
				const top = prevRow[j] ?? 0;
				currRow[j] = Math.min(diag + 1, left + 1, top + 1);
			}
		}
	}

	const maxLen = Math.max(a.length, b.length);
	const lastRow = matrix[b.length];
	const lastVal = lastRow?.[a.length] ?? 0;
	return 1 - lastVal / maxLen;
}
