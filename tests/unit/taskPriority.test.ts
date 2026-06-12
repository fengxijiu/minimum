import { describe, expect, it } from "vitest";
import { compareTaskPriority, priorityWeight } from "../../src/orchestration/taskPriority.js";

describe("compareTaskPriority — single canonical ordering", () => {
	it("orders by priority field first (P0 before P2)", () => {
		const a = { taskId: "A", priority: "P2" };
		const b = { taskId: "B", priority: "P0" };
		// b (P0) should sort before a (P2) → compare(a,b) > 0
		expect(compareTaskPriority(a, b)).toBeGreaterThan(0);
		expect(compareTaskPriority(b, a)).toBeLessThan(0);
	});

	it("treats a missing priority as P2", () => {
		expect(priorityWeight(undefined)).toBe(2);
		const a = { taskId: "A" };
		const b = { taskId: "B", priority: "P1" };
		expect(compareTaskPriority(a, b)).toBeGreaterThan(0); // P1 before default P2
	});

	it("breaks priority ties by fewer unresolved deps first", () => {
		const a = { taskId: "A" };
		const b = { taskId: "B" };
		const metrics = (id: string) =>
			id === "A" ? { unresolved: 2, downstream: 0 } : { unresolved: 1, downstream: 0 };
		// B has fewer unresolved → sorts first → compare(a,b) > 0
		expect(compareTaskPriority(a, b, metrics)).toBeGreaterThan(0);
	});

	it("breaks unresolved ties by higher downstream impact first", () => {
		const a = { taskId: "A" };
		const b = { taskId: "B" };
		const metrics = (id: string) =>
			id === "A" ? { unresolved: 0, downstream: 1 } : { unresolved: 0, downstream: 3 };
		// B has more downstream → sorts first → compare(a,b) > 0
		expect(compareTaskPriority(a, b, metrics)).toBeGreaterThan(0);
	});

	it("falls back to lexicographic taskId when everything else ties", () => {
		const a = { taskId: "A" };
		const b = { taskId: "B" };
		expect(compareTaskPriority(a, b)).toBeLessThan(0);
	});
});
