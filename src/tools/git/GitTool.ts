import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Strip ANSI escape codes from a string. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export class GitTool {
	name = "git";
	description = "Execute git commands";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					subcommand: {
						type: "string",
						description:
							"Git subcommand (status, diff, log, add, commit, push, pull, etc.)",
					},
					args: {
						type: "string",
						description: "Additional arguments",
					},
				},
				required: ["subcommand"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const cwd = context?.workingDirectory || process.cwd();
		const subcommand = args.subcommand || "status";
		const extraArgs = args.args ? args.args.split(/\s+/).filter(Boolean) : [];

		try {
			const { stdout, stderr } = await execFileAsync("git", [subcommand, ...extraArgs], {
				cwd,
				timeout: 30000,
			});

			const out = stripAnsi(stdout || "").trimEnd();
			const err = stripAnsi(stderr || "").trimEnd();

			if (out && err) return `${out}\n${err}`;
			if (out) return out;
			if (err) return err;
			return "Git command executed successfully";
		} catch (error: any) {
			// execFile throws on non-zero exit — extract the real git output
			const stderr = stripAnsi(error.stderr || "").trimEnd();
			const stdout = stripAnsi(error.stdout || "").trimEnd();

			// Prefer stderr (where git writes fatal/error messages)
			const gitOutput = stderr || stdout;

			if (gitOutput) {
				return gitOutput;
			}

			// Fallback: clean up the Node.js exec error message
			const msg = error.message || String(error);
			return `git ${subcommand} failed: ${msg}`;
		}
	}
}
