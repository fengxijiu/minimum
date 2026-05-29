import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { loadMiMoConfig, mergeConfig } from "../../src/config/index.js";
import { MockClient } from "../../src/mocks/MockClient.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";

describe("loadMiMoConfig", () => {
	let dir: string;
	let home: string;
	let prevHome: string | undefined;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cfg-"));
		// Isolate HOME so the global ~/.minimum/config.json fallback doesn't bleed in.
		home = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-home-"));
		prevHome = process.env.HOME;
		process.env.HOME = home;
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (prevHome !== undefined) process.env.HOME = prevHome;
		else process.env.HOME = undefined;
	});

	it("reads the new canonical .minimum/config.json", async () => {
		fs.mkdirSync(path.join(dir, ".minimum"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".minimum", "config.json"),
			JSON.stringify({ planMode: true, maxSteps: 9 }),
		);
		const cfg = await loadMiMoConfig(dir);
		expect(cfg.planMode).toBe(true);
		expect(cfg.maxSteps).toBe(9);
	});

	it("ignores unknown top-level keys (forward-compat)", async () => {
		fs.mkdirSync(path.join(dir, ".minimum"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".minimum", "config.json"),
			JSON.stringify({ planMode: true, maxSteps: 5, unknownFutureKey: 42 }),
		);
		const cfg = await loadMiMoConfig(dir);
		expect(cfg.planMode).toBe(true);
		expect(cfg.maxSteps).toBe(5);
	});

	it("returns {} when only unknown files exist in project dir", async () => {
		fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ provider: {} }));
		expect(await loadMiMoConfig(dir)).toEqual({});
	});

	it("falls back to ~/.minimum/config.json when no project config exists", async () => {
		fs.mkdirSync(path.join(home, ".minimum"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".minimum", "config.json"),
			JSON.stringify({ apiKey: "tp-global", defaultModel: "mimo-v2.5" }),
		);
		const cfg = await loadMiMoConfig(dir);
		expect(cfg.apiKey).toBe("tp-global");
		expect(cfg.defaultModel).toBe("mimo-v2.5");
	});

	it("project config inherits global fields it does not override", async () => {
		fs.mkdirSync(path.join(home, ".minimum"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".minimum", "config.json"),
			JSON.stringify({
				apiKey: "tp-global",
				defaultModel: "mimo-v2.5-pro",
				approvalMode: "suggest",
			}),
		);
		fs.mkdirSync(path.join(dir, ".minimum"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".minimum", "config.json"),
			JSON.stringify({ approvalMode: "auto-edit" }),
		);
		const cfg = await loadMiMoConfig(dir);
		expect(cfg.apiKey).toBe("tp-global"); // inherited
		expect(cfg.defaultModel).toBe("mimo-v2.5-pro"); // inherited
		expect(cfg.approvalMode).toBe("auto-edit"); // overridden
	});

	it("returns {} when no config file exists anywhere", async () => {
		expect(await loadMiMoConfig(dir)).toEqual({});
	});
});

describe("createMiMoStack", () => {
	it("registers todo_write compatibly with the real ToolRegistry", () => {
		const tools = new ToolRegistry();
		createMiMoStack(new MockClient(), tools, process.cwd(), {});
		expect(tools.has("todo_write")).toBe(true);
		// getDefinitions() invokes tool.getDefinition(); a bad shape would throw here.
		const def = tools.getDefinitions().find((d) => d.name === "todo_write");
		expect(def?.parameters).toBeDefined();
	});
});
