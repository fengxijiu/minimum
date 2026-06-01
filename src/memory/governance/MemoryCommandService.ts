import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderEntry, upsertSectionInFile } from "./MemoryGovernor.js";
import {
	inspectCanonical,
	inspectMemoryIndex,
	inspectStaging,
	renderMemoryReport,
} from "./MemoryInspector.js";
import { refreshMemoryIndex } from "./MemoryIndex.js";
import { canonicalPath, getOrInitManifest } from "./MemoryManifest.js";
import { deleteCandidate, listCandidates } from "./MemoryStaging.js";
import type {
	CanonicalFileInfo,
	MemoryIndexInfo,
	StagingInfo,
} from "./MemoryInspector.js";
import type { MemoryCandidate } from "./types.js";

const DEFAULT_INJECTION_BUDGET_TOKENS = 8_000;
const STATE_FILE = "memory-state.json";
const GLOBAL_CANONICAL_PATH = path.join(
	os.homedir() || process.env.HOME || "~",
	".minimum",
	"memory",
	"global.md",
);

export interface MemoryCommandState {
	enabled: boolean;
	lastCompactedAt?: string;
	injectionBudgetTokens: number;
}

export interface MemoryCommandStatus {
	projectCanonical: CanonicalFileInfo;
	globalCanonical: CanonicalFileInfo;
	canonical: CanonicalFileInfo[];
	staging: StagingInfo[];
	index: MemoryIndexInfo;
	lastCompactedAt?: string;
	injectionBudgetTokens: number;
	enabled: boolean;
}

export interface MemoryCommandServiceOptions {
	injectionBudgetTokens?: number;
}

/**
 * Command-facing service for governance memory operations.
 *
 * `MemoryCommand` delegates all memory inspection and mutation here so the
 * command layer remains a thin router instead of owning filesystem details.
 */
export class MemoryCommandService {
	constructor(
		private readonly projectRoot: string,
		private readonly options: MemoryCommandServiceOptions = {},
	) {}

	async status(): Promise<MemoryCommandStatus> {
		const [canonical, staging, index, state] = await Promise.all([
			inspectCanonical(this.projectRoot),
			inspectStaging(this.projectRoot),
			inspectMemoryIndex(this.projectRoot),
			this.readState(),
		]);
		const projectCanonical = canonical.find((entry) => entry.key === "project") ?? {
			key: "project",
			path: ".minimum/project.md",
			exists: false,
			bytes: 0,
		};
		const globalCanonical = await this.globalCanonicalInfo();
		return {
			projectCanonical,
			globalCanonical,
			canonical,
			staging,
			index,
			lastCompactedAt: state.lastCompactedAt,
			injectionBudgetTokens: state.enabled ? state.injectionBudgetTokens : 0,
			enabled: state.enabled,
		};
	}

	async project(): Promise<string> {
		const status = await this.status();
		return renderMemoryReport(status.canonical, [], status.index);
	}

	async global(): Promise<string> {
		const info = await this.globalCanonicalInfo();
		return [
			"Global memory:",
			`  ${info.exists ? "●" : "○"} ${info.path} (${info.exists ? `${info.bytes}B` : "missing"})`,
		].join("\n");
	}

	async staging(): Promise<string> {
		const staging = await inspectStaging(this.projectRoot);
		return renderMemoryReport([], staging);
	}

	async approve(id: string): Promise<string> {
		const candidate = await this.findCandidate(id);
		if (!candidate) return `No staged memory candidate found for id: ${id}`;

		const manifest = await getOrInitManifest(this.projectRoot);
		const target =
			canonicalPath(manifest, this.projectRoot, "project") ??
			path.join(this.projectRoot, manifest.memoryRoot, "project.md");
		await upsertSectionInFile(target, "Approved Memory", renderEntry(candidate), "append");
		await this.deleteCandidate(candidate);
		await refreshMemoryIndex(this.projectRoot, manifest);
		return `Approved staged memory candidate ${id} into ${path.relative(this.projectRoot, target)}`;
	}

	async reject(id: string): Promise<string> {
		const candidate = await this.findCandidate(id);
		if (!candidate) return `No staged memory candidate found for id: ${id}`;
		await this.deleteCandidate(candidate);
		await refreshMemoryIndex(this.projectRoot);
		return `Rejected staged memory candidate ${id}`;
	}

	async forget(id: string): Promise<string> {
		const candidate = await this.findCandidate(id);
		if (!candidate) return `No staged memory candidate found for id: ${id}`;
		await this.deleteCandidate(candidate);
		await refreshMemoryIndex(this.projectRoot);
		return `Forgot staged memory candidate ${id}`;
	}

	async compact(): Promise<string> {
		const state = await this.readState();
		const next: MemoryCommandState = {
			...state,
			lastCompactedAt: new Date().toISOString(),
		};
		await this.writeState(next);
		await refreshMemoryIndex(this.projectRoot);
		return `Memory compacted at ${next.lastCompactedAt}`;
	}

	async enable(): Promise<string> {
		const state = await this.readState();
		await this.writeState({ ...state, enabled: true });
		return `Memory injection enabled (${state.injectionBudgetTokens} tokens)`;
	}

	async disable(): Promise<string> {
		const state = await this.readState();
		await this.writeState({ ...state, enabled: false });
		return "Memory injection disabled";
	}

	renderStatus(status: MemoryCommandStatus): string {
		const lines = [
			"Memory status:",
			`  Enabled: ${status.enabled ? "on" : "off"}`,
			`  Project canonical: ${status.projectCanonical.path} (${
				status.projectCanonical.exists ? `${status.projectCanonical.bytes}B` : "missing"
			})`,
			`  Global canonical: ${status.globalCanonical.path} (${
				status.globalCanonical.exists ? `${status.globalCanonical.bytes}B` : "missing"
			})`,
			`  Staging: ${status.staging.length} candidate${status.staging.length === 1 ? "" : "s"}`,
			`  Index entries: ${status.index.entryCount}${status.index.exists ? "" : " (missing index)"}`,
			`  Last compacted: ${status.lastCompactedAt ?? "never"}`,
			`  Injection budget: ${status.injectionBudgetTokens} tokens`,
		];
		return lines.join("\n");
	}

	private async readState(): Promise<MemoryCommandState> {
		const defaults = this.defaultState();
		try {
			const text = await fs.readFile(this.statePath(), "utf-8");
			const parsed = JSON.parse(text) as Partial<MemoryCommandState>;
			return {
				enabled: parsed.enabled ?? defaults.enabled,
				lastCompactedAt: parsed.lastCompactedAt,
				injectionBudgetTokens: parsed.injectionBudgetTokens ?? defaults.injectionBudgetTokens,
			};
		} catch {
			return defaults;
		}
	}

	private async writeState(state: MemoryCommandState): Promise<void> {
		const file = this.statePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	}

	private defaultState(): MemoryCommandState {
		return {
			enabled: true,
			injectionBudgetTokens: this.options.injectionBudgetTokens ?? DEFAULT_INJECTION_BUDGET_TOKENS,
		};
	}

	private statePath(): string {
		return path.join(this.projectRoot, ".minimum", STATE_FILE);
	}

	private async globalCanonicalInfo(): Promise<CanonicalFileInfo> {
		let exists = false;
		let bytes = 0;
		try {
			const stat = await fs.stat(GLOBAL_CANONICAL_PATH);
			exists = true;
			bytes = stat.size;
		} catch {
			exists = false;
		}
		return {
			key: "global",
			path: GLOBAL_CANONICAL_PATH,
			exists,
			bytes,
		};
	}

	private async findCandidate(id: string): Promise<MemoryCandidate | undefined> {
		const candidates = await listCandidates(this.projectRoot);
		return candidates.find((candidate) => this.candidateId(candidate) === id);
	}

	private async deleteCandidate(candidate: MemoryCandidate): Promise<void> {
		if (candidate.sourcePath) await deleteCandidate(candidate.sourcePath);
	}

	private candidateId(candidate: MemoryCandidate): string {
		return `${candidate.sourceTask}.${candidate.persona}`;
	}
}
