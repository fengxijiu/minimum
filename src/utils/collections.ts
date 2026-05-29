/**
 * Group items into a Map keyed by a derived value, preserving insertion order
 * within each bucket. Replaces the hand-rolled `get(k) ?? []; push; set(k)`
 * idiom that recurred across the orchestration layer.
 */
export function groupBy<T, K>(items: Iterable<T>, keyFn: (item: T) => K): Map<K, T[]> {
	const out = new Map<K, T[]>();
	for (const item of items) {
		const key = keyFn(item);
		const list = out.get(key);
		if (list) list.push(item);
		else out.set(key, [item]);
	}
	return out;
}
