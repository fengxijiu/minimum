import { extractXmlBlock, type TaskResult } from "./TaskRunner.js";
import type { LaunchArtifact, LaunchRequirement, TaskContract } from "./TaskContract.js";

export type ArtifactMap = Map<string, Map<LaunchArtifact, string>>;

export interface GateIssue {
	taskId: string;
	requirement: LaunchRequirement;
	reason: string;
}

export interface GateDecision {
	ok: boolean;
	issues: GateIssue[];
}

const ARTIFACT_TAGS: LaunchArtifact[] = [
	"file_list",
	"relevant_files",
	"tech_stack",
	"test_commands",
	"static_compile_commands",
	"visual_summary",
];

export function buildArtifactMap(results: TaskResult[]): ArtifactMap {
	const out: ArtifactMap = new Map();
	for (const result of results) {
		const artifacts = new Map<LaunchArtifact, string>();
		for (const artifact of ARTIFACT_TAGS) {
			const value = extractXmlBlock(result.report, artifact).trim();
			if (value) artifacts.set(artifact, value);
		}
		out.set(result.taskId, artifacts);
	}
	return out;
}

export function evaluateLaunchGate(
	contract: TaskContract,
	results: TaskResult[],
	artifacts: ArtifactMap,
): GateDecision {
	const issues: GateIssue[] = [];
	if (contract.postStaticCompile?.required && contract.postStaticCompile.commands.length === 0) {
		issues.push({
			taskId: contract.taskId,
			requirement: {
				sourceTaskId: contract.dependsOn[0] ?? contract.taskId,
				artifact: "static_compile_commands",
				required: true,
			},
			reason: "static compile command is unavailable or incomplete",
		});
	}
	const byTask = new Map(results.map((r) => [r.taskId, r]));
	for (const requirement of contract.launchRequirements ?? []) {
		if (!requirement.required) continue;
		const upstream = byTask.get(requirement.sourceTaskId);
		if (!upstream) {
			issues.push({
				taskId: contract.taskId,
				requirement,
				reason: `${requirement.sourceTaskId}.${requirement.artifact} is unavailable because upstream task result is missing`,
			});
			continue;
		}
		if (upstream.status !== "ok") {
			if (hasNonBlockingDirective(upstream)) {
				continue;
			}
			if (canUseReadonlyFallback(requirement, upstream)) {
				continue;
			}
			issues.push({
				taskId: contract.taskId,
				requirement,
				reason: `${requirement.sourceTaskId}.${requirement.artifact} is unavailable because upstream task status is ${upstream.status}`,
			});
			continue;
		}
		const value = artifacts.get(requirement.sourceTaskId)?.get(requirement.artifact)?.trim();
		if (!value) {
			if (hasNonBlockingDirective(upstream)) {
				continue;
			}
			if (canUseReadonlyFallback(requirement, upstream)) {
				continue;
			}
			issues.push({
				taskId: contract.taskId,
				requirement,
				reason: `${requirement.sourceTaskId}.${requirement.artifact} is unavailable or incomplete`,
			});
		}
	}
	return { ok: issues.length === 0, issues };
}

export function canUseReadonlyFallback(
	requirement: LaunchRequirement,
	upstream: TaskResult,
): boolean {
	if (requirement.artifact === "static_compile_commands") return false;
	if (upstream.personaId !== "repo_scout") return false;
	if (upstream.status !== "degraded") return false;
	if (upstream.fallbackAccess?.mode !== "readonly_workspace" || !upstream.fallbackAccess.allowed) return false;
	const explicit = requirement.fallback;
	if (!explicit) return true;
	if (explicit.mode !== "readonly_workspace") return false;
	if (explicit.allowedWhen.length === 0) return true;
	return explicit.allowedWhen.some((condition) => {
		const c = condition.toLowerCase();
		return c === "upstream_status:degraded" ||
			c === "repo_scout_degraded" ||
			c === "readonly_workspace_available";
	});
}

export function hasNonBlockingDirective(result: TaskResult): boolean {
	const directive = extractXmlBlock(result.report, "pipeline_directive");
	if (!directive) return false;
	return /blocking:\s*false/i.test(directive);
}

export function isContextGapBlocked(result: TaskResult): boolean {
	if (result.status !== "blocked") return false;
	const text = `${result.report}\n${result.errors.join("\n")}`.toLowerCase();
	return /context|artifact|file[_\s-]?list|relevant[_\s-]?files|tech[_\s-]?stack|test[_\s-]?commands|visual[_\s-]?summary/.test(text);
}
