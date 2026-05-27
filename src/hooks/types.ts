export type HookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "Stop";

export const HOOK_EVENTS: readonly HookEvent[] = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
];

export interface HookConfig {
	event: HookEvent;
	command: string;
	match?: string;
	timeout?: number;
	description?: string;
}

export interface Hook {
	id: string;
	event: HookEvent;
	command: string;
	match?: RegExp;
	timeout: number;
	description?: string;
}

export interface HookContext {
	toolName?: string;
	toolArgs?: Record<string, any>;
	toolResult?: any;
	userPrompt?: string;
	workingDirectory: string;
}

export interface HookResult {
	hookId: string;
	success: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	duration: number;
}
