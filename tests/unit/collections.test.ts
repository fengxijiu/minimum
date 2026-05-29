import { describe, expect, it } from "vitest";
import { groupBy } from "../../src/utils/collections.js";

describe("groupBy", () => {
	it("groups items by a derived key", () => {
		const items = [
			{ id: 1, kind: "a" },
			{ id: 2, kind: "b" },
			{ id: 3, kind: "a" },
		];
		const groups = groupBy(items, (i) => i.kind);
		expect(groups.get("a")!.map((i) => i.id)).toEqual([1, 3]);
		expect(groups.get("b")!.map((i) => i.id)).toEqual([2]);
	});

	it("preserves insertion order within each bucket", () => {
		const groups = groupBy([3, 1, 2, 4], (n) => n % 2);
		expect(groups.get(1)).toEqual([3, 1]);
		expect(groups.get(0)).toEqual([2, 4]);
	});

	it("returns an empty map for empty input", () => {
		expect(groupBy([], () => "x").size).toBe(0);
	});

	it("supports non-string keys", () => {
		const groups = groupBy([1.1, 1.9, 2.2], Math.floor);
		expect(groups.get(1)).toEqual([1.1, 1.9]);
		expect(groups.get(2)).toEqual([2.2]);
	});
});
