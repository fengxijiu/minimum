import { formatJobRead } from "./format.js";
import type { JobRegistry } from "./JobRegistry.js";

export interface JobOutputToolOptions {
	jobs: JobRegistry;
}

export class JobOutputTool {
	name = "job_output";
	description =
		"Read the latest output of a background job. Tail of buffer (last 80 lines by default). Pass `since` to stream only new content.";

	private readonly jobs: JobRegistry;

	constructor(options: JobOutputToolOptions) {
		this.jobs = options.jobs;
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					jobId: {
						type: "integer",
						description: "Job id returned by run_background.",
					},
					since: {
						type: "integer",
						description: "Byte offset for incremental polling.",
					},
					tailLines: {
						type: "integer",
						description: "Cap to last N lines. Default 80.",
					},
				},
				required: ["jobId"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const jobId = Number(args.jobId);
		if (!Number.isInteger(jobId) || jobId <= 0) return "Error: invalid jobId";
		const out = this.jobs.read(jobId, {
			since: typeof args.since === "number" ? args.since : undefined,
			tailLines: typeof args.tailLines === "number" ? args.tailLines : 80,
		});
		if (!out) return `job ${jobId}: not found (use list_jobs)`;
		return formatJobRead(jobId, out);
	}
}
