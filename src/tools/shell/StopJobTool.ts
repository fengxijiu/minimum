import { formatJobStop } from "./format.js";
import type { JobRegistry } from "./JobRegistry.js";

export interface StopJobToolOptions {
	jobs: JobRegistry;
	onJobsChanged?: () => void;
}

export class StopJobTool {
	name = "stop_job";
	description =
		"Stop a background job. SIGTERM first; SIGKILL after grace period if it doesn't exit cleanly. Safe to call on already-exited jobs.";

	private readonly jobs: JobRegistry;
	private readonly onJobsChanged?: () => void;

	constructor(options: StopJobToolOptions) {
		this.jobs = options.jobs;
		this.onJobsChanged = options.onJobsChanged;
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					jobId: { type: "integer" },
				},
				required: ["jobId"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const jobId = Number(args.jobId);
		if (!Number.isInteger(jobId) || jobId <= 0) return "Error: invalid jobId";
		const rec = await this.jobs.stop(jobId);
		this.onJobsChanged?.();
		if (!rec) return `job ${jobId}: not found`;
		return formatJobStop(rec);
	}
}
