import { extractXmlBlock, type TaskResult } from "./TaskRunner.js";
import type { LaunchArtifact } from "./TaskContract.js";

/**
 * ArtifactIndex — extracts structured launch artifacts from task reports.
 *
 * Workers emit artifacts in XML blocks within <task_report>:
 *   <file_list>...</file_list>
 *   <tech_stack>...</tech_stack>
 *   <test_commands>...</test_commands>
 *   <static_compile_commands>...</static_compile_commands>
 *
 * The index maps (taskId, artifact) → extracted text so downstream
 * LaunchGate checks can query it without re-parsing raw reports.
 */
export class ArtifactIndex {
	private index = new Map<string, Map<LaunchArtifact, string>>();

	private static ARTIFACT_TAGS: LaunchArtifact[] = [
		"file_list",
		"relevant_files",
		"tech_stack",
		"test_commands",
		"static_compile_commands",
		"visual_summary",
	];

	/** Parse a fresh task result and populate the index. */
	ingest(taskId: string, result: TaskResult): void {
		const artifacts = new Map<LaunchArtifact, string>();
		for (const artifact of ArtifactIndex.ARTIFACT_TAGS) {
			const value = extractXmlBlock(result.report, artifact).trim();
			if (value) artifacts.set(artifact, value);
		}
		this.index.set(taskId, artifacts);
	}

	/** Look up an artifact value for a given task. */
	get(taskId: string, artifact: LaunchArtifact): string | undefined {
		return this.index.get(taskId)?.get(artifact);
	}

	/** Check whether a required artifact is present and non-empty. */
	has(taskId: string, artifact: LaunchArtifact): boolean {
		const value = this.get(taskId, artifact);
		return value !== undefined && value.length > 0;
	}

	/** @returns all task IDs currently indexed. */
	get keys(): string[] {
		return [...this.index.keys()];
	}

	get size(): number {
		return this.index.size;
	}
}
