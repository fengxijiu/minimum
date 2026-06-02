import type { JobRegistry } from "./JobRegistry.js";

export interface WaitForJobToolOptions {
	jobs: JobRegistry;
	onJobsChanged?: () => void;
}

export class WaitForJobTool {
	name = "wait_for_job";
	description =
		"Block server-side until a background job finishes or produces new output (opt-in), bounded by timeoutMs. Returns JSON.";

	private readonly jobs: JobRegistry;
	private readonly onJobsChanged?: () => void;

	constructor(options: WaitForJobToolOptions) {
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
					jobId: {
						type: "integer",
						description: "Job id returned by run_background.",
					},
					timeoutMs: {
						type: "integer",
						description: "Max ms to block. 0..300000. Default 5000.",
					},
					waitFor: {
						type: "string",
						enum: ["exit", "output-or-exit"],
						description: "Wake condition. Default 'exit'.",
					},
				},
				required: ["jobId"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const jobId = Number(args.jobId);
		if (!Number.isInteger(jobId) || jobId <= 0) return "Error: invalid jobId";
		const out = await this.jobs.waitForJob(jobId, {
			timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
			waitFor: args.waitFor === "output-or-exit" ? "output-or-exit" : "exit",
		});
		if (!out) return `job ${jobId}: not found (use list_jobs)`;
		if (out.exited) this.onJobsChanged?.();
		return JSON.stringify({
			jobId,
			exited: out.exited,
			exitCode: out.exitCode,
			latestOutput: out.latestOutput,
		});
	}
}
