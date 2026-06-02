import { describe, expect, it } from "vitest";
import { resolveMemory } from "../../src/memory/single/MemoryResolver.js";
import type { MemoryRecord } from "../../src/memory/single/types.js";

const record = (overrides: Partial<MemoryRecord>): MemoryRecord => ({
	id: "memory-id",
	layer: "global",
	scope: "formatting",
	key: "indentation",
	content: "Use spaces",
	confidence: "medium",
	source: "test",
	updatedAt: "2026-01-01T00:00:00.000Z",
	tags: [],
	relatedFiles: [],
	...overrides,
});

describe("resolveMemory", () => {
	it("keeps project memory when it conflicts with global memory", () => {
		const resolved = resolveMemory([
			record({ id: "global", layer: "global", content: "Use npm" }),
			record({ id: "project", layer: "project", content: "Use pnpm" }),
		]);

		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.id).toBe("project");
		expect(resolved[0]?.content).toBe("Use pnpm");
	});

	it("keeps higher confidence memory for duplicate keys or scopes", () => {
		const resolved = resolveMemory([
			record({ id: "low", confidence: "low", content: "Prefer callbacks" }),
			record({ id: "high", confidence: "high", content: "Prefer async/await" }),
		]);

		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.id).toBe("high");
		expect(resolved[0]?.content).toBe("Prefer async/await");
	});

	it("keeps the most recently updated memory when confidence ties", () => {
		const resolved = resolveMemory([
			record({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
			record({ id: "new", updatedAt: "2026-05-01T00:00:00.000Z" }),
		]);

		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.id).toBe("new");
	});

	it("does not let long-term memory override an explicit preference in the current turn", () => {
		const resolved = resolveMemory(
			[
				record({
					id: "long-term-style",
					layer: "project",
					key: "style",
					content: "Prefer Jest for tests",
				}),
				record({
					id: "unrelated",
					layer: "project",
					key: "runtime",
					scope: "node",
					content: "Use Node 22",
				}),
			],
			"For this turn, style preference is Vitest tests.",
		);

		expect(resolved.map((memory) => memory.id)).toEqual(["unrelated"]);
	});

	it("sorts resolved memories by layer priority", () => {
		const resolved = resolveMemory([
			record({
				id: "global",
				layer: "global",
				key: "global-key",
				scope: "global-scope",
			}),
			record({
				id: "session",
				layer: "session",
				key: "session-key",
				scope: "session-scope",
			}),
			record({
				id: "project",
				layer: "project",
				key: "project-key",
				scope: "project-scope",
			}),
		]);

		expect(resolved.map((memory) => memory.id)).toEqual([
			"session",
			"project",
			"global",
		]);
	});
});
