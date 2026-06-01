import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MissionCheckReport } from "./MissionChecker.js";
import type { RefinementEntry, RefineResult } from "./Refiner.js";
import type { CoarseDag, TaskContract } from "./TaskContract.js";

export interface ArtifactPaths {
	dag?: string;
	refinements: string[];
	contracts: string[];
	missionChecks: string[];
	repairDags: string[];
	memoryIndex?: string;
}

export interface WrittenMissionCheck {
	markdownPath: string;
	jsonPath: string;
}

export function emptyArtifactPaths(): ArtifactPaths {
	return {
		refinements: [],
		contracts: [],
		missionChecks: [],
		repairDags: [],
	};
}

export async function writeDag(
	projectRoot: string,
	epicId: string,
	dag: CoarseDag,
): Promise<string> {
	return writeJson(projectRoot, ["tasks", epicId, "dag.json"], dag);
}

export async function writeRepairDag(
	projectRoot: string,
	epicId: string,
	loopIndex: number,
	dag: CoarseDag,
): Promise<string> {
	return writeJson(projectRoot, ["tasks", epicId, "repair-dags", `${loopIndex}.json`], dag);
}

export async function writeRefinement(
	projectRoot: string,
	epicId: string,
	passId: string,
	entries: Iterable<RefinementEntry>,
	error?: string,
): Promise<string> {
	return writeJson(projectRoot, ["tasks", epicId, "refinements", `${passId}.json`], {
		passId,
		ok: !error,
		...(error && { error }),
		tasks: Array.from(entries),
	});
}

export async function writeContracts(
	projectRoot: string,
	epicId: string,
	passId: string,
	contracts: TaskContract[],
	errors: RefineResult["errors"],
): Promise<string> {
	return writeJson(projectRoot, ["tasks", epicId, "contracts", `${passId}.json`], {
		passId,
		contracts,
		errors,
	});
}

export async function writeMissionCheck(
	projectRoot: string,
	epicId: string,
	index: number,
	rawReport: string,
	parsedReport: MissionCheckReport,
): Promise<WrittenMissionCheck> {
	const markdownPath = artifactPath(projectRoot, ["tasks", epicId, "mission-checks", `${index}.md`]);
	await fs.mkdir(path.dirname(markdownPath), { recursive: true });
	await fs.writeFile(markdownPath, rawReport.endsWith("\n") ? rawReport : `${rawReport}\n`, "utf-8");
	const jsonPath = await writeJson(projectRoot, ["tasks", epicId, "mission-checks", `${index}.json`], parsedReport);
	return { markdownPath, jsonPath };
}

export function artifactPath(projectRoot: string, parts: string[]): string {
	return path.join(projectRoot, ".minimum", ...parts);
}

async function writeJson(projectRoot: string, parts: string[], value: unknown): Promise<string> {
	const filePath = artifactPath(projectRoot, parts);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	return filePath;
}
