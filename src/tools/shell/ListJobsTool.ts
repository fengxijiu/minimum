import { formatJobRow } from "./format.js";
import type { JobRegistry } from "./JobRegistry.js";

export interface ListJobsToolOptions {
	jobs: JobRegistry;
}

export class ListJobsTool {
	name = "list_jobs";
	description =
		"List every background job started this session — running and exited — with id, command, pid, status.";

	private readonly jobs: JobRegistry;

	constructor(options: ListJobsToolOptions) {
		this.jobs = options.jobs;
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: { type: "object", properties: {} },
		};
	}

	async execute(_args: Record<string, any>): Promise<string> {
		const all = this.jobs.list();
		if (all.length === 0) return "(no background jobs started this session)";
		return all.map(formatJobRow).join("\n");
	}
}
