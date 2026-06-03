import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/session/SessionManager.js";

describe("Session Workflow", () => {
	let manager: SessionManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-test-"));
		manager = new SessionManager(tempDir);
		await manager.initialize();
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("should create and load session", async () => {
		// 创建会话
		const session = await manager.createSession("test-session");
		expect(session.id).toBe("test-session");

		// 添加消息
		await manager.addMessage({ role: "user", content: "Hello" });
		await manager.addMessage({ role: "assistant", content: "Hi!" });

		// 获取消息
		const messages = manager.getMessages();
		expect(messages.length).toBe(2);
	});

	it("should create and restore checkpoint", async () => {
		// 创建会话
		await manager.createSession("checkpoint-test");

		// 添加消息
		await manager.addMessage({ role: "user", content: "Message 1" });

		// 创建检查点
		const checkpointId = await manager.createCheckpoint();
		expect(checkpointId).toBeDefined();

		// 添加更多消息
		await manager.addMessage({ role: "user", content: "Message 2" });
		expect(manager.getMessages().length).toBe(2);

		// 恢复检查点
		const restored = await manager.restoreCheckpoint(checkpointId);
		expect(restored).toBe(true);
		expect(manager.getMessages().length).toBe(1);
	});

	it("should list sessions", async () => {
		await manager.createSession("session-1");
		await manager.createSession("session-2");
		await manager.createSession("session-3");

		const sessions = await manager.listSessions();
		expect(sessions.length).toBe(3);
	});

	it("should load the last persisted session", async () => {
		await manager.persistFromLoop([{ role: "user", content: "latest" }], { steps: 1 });
		const loaded = await manager.loadLastSession();
		expect(loaded?.messages).toEqual([{ role: "user", content: "latest" }]);
		expect(manager.getCurrentSession()?.id).toBe(loaded?.id);
	});

	it("should list checkpoints", async () => {
		await manager.createSession("checkpoint-list-test");
		await manager.addMessage({ role: "user", content: "Hello" });

		await manager.createCheckpoint({ type: "manual" });
		await manager.createCheckpoint({ type: "auto" });

		const checkpoints = await manager.listCheckpoints();
		expect(checkpoints.length).toBeGreaterThanOrEqual(2);
	});
});
