import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/MemoryStore.js";
import {
	AppendOnlyLog,
	RuntimeMemory,
} from "../../src/memory/RuntimeMemory.js";

describe("Memory", () => {
	describe("AppendOnlyLog", () => {
		let log: AppendOnlyLog;

		beforeEach(() => {
			log = new AppendOnlyLog();
		});

		it("should append entries", () => {
			log.append({ role: "user", content: "Hello" });
			log.append({ role: "assistant", content: "Hi" });

			expect(log.length).toBe(2);
		});

		it("should convert to messages", () => {
			log.append({ role: "user", content: "Hello" });
			log.append({ role: "assistant", content: "Hi" });

			const messages = log.toMessages();
			expect(messages.length).toBe(2);
			expect(messages[0].role).toBe("user");
			expect(messages[1].role).toBe("assistant");
		});

		it("should clear entries", () => {
			log.append({ role: "user", content: "Hello" });
			log.clear();

			expect(log.length).toBe(0);
		});

		it("should get entries", () => {
			log.append({ role: "user", content: "Hello" });
			const entries = log.getEntries();

			expect(entries.length).toBe(1);
			expect(entries[0].role).toBe("user");
		});

		it("should extend multiple entries", () => {
			log.extend([
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi" },
			]);

			expect(log.length).toBe(2);
		});
	});

	describe("RuntimeMemory", () => {
		let memory: RuntimeMemory;

		beforeEach(() => {
			memory = new RuntimeMemory();
		});

		it("should have log and scratch", () => {
			expect(memory.log).toBeDefined();
			expect(memory.scratch).toBeDefined();
		});

		it("should clear all", () => {
			memory.log.append({ role: "user", content: "Hello" });
			memory.scratch.notes.push("test");

			memory.clear();

			expect(memory.log.length).toBe(0);
			expect(memory.scratch.notes.length).toBe(0);
		});

		it("should support scratch notes", () => {
			memory.scratch.notes.push("note1");
			memory.scratch.notes.push("note2");

			expect(memory.scratch.notes.length).toBe(2);
		});

		it("should support scratch reasoning", () => {
			memory.scratch.reasoning = "test reasoning";
			expect(memory.scratch.reasoning).toBe("test reasoning");
		});
	});

	describe("MemoryStore", () => {
		let store: MemoryStore;
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"));
			store = new MemoryStore({ basePath: tempDir });
			await store.initialize();
		});

		afterEach(async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
		});

		it("should set and get memory", async () => {
			await store.set({
				key: "test-key",
				value: "test-value",
				type: "user",
				timestamp: Date.now(),
			});

			const entry = await store.get("test-key");
			expect(entry).toBeDefined();
			expect(entry?.value).toBe("test-value");
		});

		it("should list memories", async () => {
			await store.set({
				key: "key1",
				value: "value1",
				type: "user",
				timestamp: Date.now(),
			});

			await store.set({
				key: "key2",
				value: "value2",
				type: "project",
				timestamp: Date.now(),
			});

			const entries = await store.list();
			expect(entries.length).toBe(2);
		});

		it("should list memories by type", async () => {
			await store.set({
				key: "key1",
				value: "value1",
				type: "user",
				timestamp: Date.now(),
			});

			await store.set({
				key: "key2",
				value: "value2",
				type: "project",
				timestamp: Date.now(),
			});

			const entries = await store.list("user");
			expect(entries.length).toBe(1);
			expect(entries[0].key).toBe("key1");
		});

		it("should delete memory", async () => {
			await store.set({
				key: "test-key",
				value: "test-value",
				type: "user",
				timestamp: Date.now(),
			});

			const deleted = await store.delete("test-key");
			expect(deleted).toBe(true);

			const entry = await store.get("test-key");
			expect(entry).toBeUndefined();
		});

		it("should search memories", async () => {
			await store.set({
				key: "preference",
				value: "dark mode",
				type: "user",
				timestamp: Date.now(),
			});

			await store.set({
				key: "style",
				value: "use tabs",
				type: "project",
				timestamp: Date.now(),
			});

			const results = await store.search("dark");
			expect(results.length).toBe(1);
			expect(results[0].key).toBe("preference");
		});

		it("should clear all memories", async () => {
			await store.set({
				key: "key1",
				value: "value1",
				type: "user",
				timestamp: Date.now(),
			});

			await store.clear();

			const entries = await store.list();
			expect(entries.length).toBe(0);
		});
	});
});
