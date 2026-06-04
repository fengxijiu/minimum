import type { PipelinePhase } from "./MiMoPipeline.js";

/**
 * StageDisplay — the single source of truth mapping internal pipeline phase
 * codes to user-facing names and descriptions.
 *
 * The internal codes (`W0/W1/W0.5/W2/3/W3.5/W4`) stay on events, contracts,
 * the parser and prompt output constraints. Everything a user reads — the TUI
 * pipeline panel, notices, choice prompts — goes through here so the surface
 * vocabulary never drifts from the control flow.
 *
 *   Plan -> Scan -> Refine -> Build -> Accept -> Finalize
 */
export interface StageDisplay {
	name: string;
	description: string;
}

const STAGE_DISPLAY: Record<PipelinePhase, StageDisplay> = {
	W0: { name: "Plan", description: "compiling the task graph" },
	W1: { name: "Scan", description: "perceiving the repository" },
	"W0.5": { name: "Refine", description: "refining task contracts" },
	"W2/3": { name: "Build", description: "running implementation and validation" },
	"W3.5": { name: "Accept", description: "checking acceptance" },
	W4: { name: "Finalize", description: "finalizing and merging memory" },
};

/** Internal phase codes in user-facing display order. */
export const STAGE_ORDER: PipelinePhase[] = ["W0", "W1", "W0.5", "W2/3", "W3.5", "W4"];

const UNKNOWN_STAGE: StageDisplay = { name: "Stage", description: "" };

/** Look up the display name + description for an internal phase code. */
export function stageDisplay(phase: string): StageDisplay {
	return STAGE_DISPLAY[phase as PipelinePhase] ?? UNKNOWN_STAGE;
}

/** Short user-facing name for an internal phase code (falls back to "Stage"). */
export function stageName(phase: string): string {
	return stageDisplay(phase).name;
}

/**
 * Compose a stage label with retry/repair suffixes, e.g. "Refine retry" or
 * "Build repair 1". The base is the short stage name; suffixes are appended
 * verbatim (already including a leading space).
 */
export function stageLabel(phase: string, ...suffixes: string[]): string {
	return `${stageName(phase)}${suffixes.join("")}`;
}
