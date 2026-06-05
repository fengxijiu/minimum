import { describe, expect, it } from "vitest";
import { runCommand, SKILL_CATALOG } from "../../tui/src/commands.js";
import type { AppState } from "../../tui/src/types.js";

const base: AppState = {
	path: "/proj",
	branch: "main",
	mode: "agent",
	approvalMode: "auto-edit",
	ctx: { used: 10, max: 200 },
	files: [],
	edits: [],
	redo: [],
	plan: { title: "", steps: [] },
	currentStepLabel: "",
	messages: [],
	committedCount: 0,
	input: "",
	pending: null,
	mcpServers: [],
	mcpLoading: false,
	planMode: false,
	verbose: false,
	showHelp: false,
	showWelcome: false,
	usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
	pipeline: null,
	toast: null,
	pet: null,
	petMood: "idle",
	sessionName: null,
};

describe("/skill command", () => {
	it("lists skills with /skill", () => {
		const out = runCommand("/skill", base);
		expect(out.kind).toBe("note");
		if (out.kind === "note") {
			expect(out.note).toContain("code-review");
			expect(out.note).toContain("refactor");
			expect(out.note).toContain("test-generator");
			expect(out.note).toContain("documentation");
		}
	});

	it("lists skills with /skill list", () => {
		const out = runCommand("/skill list", base);
		expect(out.kind).toBe("note");
		if (out.kind === "note") {
			expect(out.note).toContain(`Available skills (${SKILL_CATALOG.length})`);
		}
	});

	it("shows skill info with /skill info <name>", () => {
		const out = runCommand("/skill info code-review", base);
		expect(out.kind).toBe("note");
		if (out.kind === "note") {
			expect(out.note).toContain("code-review");
			expect(out.note).toContain("review");
		}
	});

	it("runs a skill as pipeline with /skill run <name>", () => {
		const out = runCommand("/skill run code-review", base);
		expect(out.kind).toBe("pipeline");
		if (out.kind === "pipeline") {
			expect(out.text.length).toBeGreaterThan(10);
		}
	});

	it("runs a skill as pipeline with shorthand /skill <name>", () => {
		const out = runCommand("/skill refactor", base);
		expect(out.kind).toBe("pipeline");
		if (out.kind === "pipeline") {
			expect(out.text).toContain("refactor");
		}
	});

	it("returns warn note for unknown skill name", () => {
		const out = runCommand("/skill run nonexistent", base);
		expect(out.kind).toBe("note");
		if (out.kind === "note") {
			expect(out.tone).toBe("warn");
			expect(out.note).toContain("nonexistent");
		}
	});

	it("returns warn note for unknown skill info", () => {
		const out = runCommand("/skill info nonexistent", base);
		expect(out.kind).toBe("note");
		if (out.kind === "note") {
			expect(out.tone).toBe("warn");
		}
	});

	it("SKILL_CATALOG includes built-in and GitHub workflow skills", () => {
		expect(SKILL_CATALOG.length).toBeGreaterThanOrEqual(9);
		expect(SKILL_CATALOG.map((s) => s.name)).toEqual(expect.arrayContaining([
			"code-review",
			"documentation",
			"github-pr-review",
			"github-fix-ci",
			"github-address-comments",
			"github-create-pr",
			"github-release-notes",
		]));
		for (const s of SKILL_CATALOG) {
			expect(s.name).toBeTruthy();
			expect(s.description).toBeTruthy();
			expect(s.prompt.length).toBeGreaterThan(20);
		}
	});
});
