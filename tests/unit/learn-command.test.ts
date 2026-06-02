import { describe, expect, it } from "vitest";
import { runCommand } from "../../tui/src/commands.js";
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

describe("/learn command", () => {
	it("parses /learn --name pipeline-loop-check", () => {
		const out = runCommand("/learn --name pipeline-loop-check", base);
		expect(out).toEqual({
			kind: "learn.create",
			preferredName: "pipeline-loop-check",
			dryRun: false,
		});
	});

	it("parses /learn --dry-run", () => {
		const out = runCommand("/learn --dry-run", base);
		expect(out).toMatchObject({ kind: "learn.create", dryRun: true });
	});

	it("parses preview/apply/reject/status subcommands", () => {
		expect(runCommand("/learn preview learn_1", base)).toEqual({
			kind: "learn.preview",
			draftId: "learn_1",
		});
		expect(runCommand("/learn apply learn_1 --load", base)).toEqual({
			kind: "learn.apply",
			draftId: "learn_1",
			load: true,
			confirmRouting: false,
		});
		expect(runCommand("/learn apply learn_1 --confirm-routing", base)).toEqual({
			kind: "learn.apply",
			draftId: "learn_1",
			load: false,
			confirmRouting: true,
		});
		expect(runCommand("/learn reject learn_1", base)).toEqual({
			kind: "learn.reject",
			draftId: "learn_1",
		});
		expect(runCommand("/learn status", base)).toEqual({ kind: "learn.status" });
	});
});
