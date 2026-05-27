import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class ExecShellTool {
	name = "exec_shell";
	description = "Execute a shell command";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "Shell command to execute",
					},
					timeout: {
						type: "number",
						description: "Timeout in milliseconds (default: 30000)",
					},
					cwd: {
						type: "string",
						description: "Working directory",
					},
				},
				required: ["command"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const cwd = args.cwd || context?.workingDirectory || process.cwd();
		const timeout = args.timeout || 30000;

		try {
			const { stdout, stderr } = await execAsync(args.command, {
				cwd,
				timeout,
				maxBuffer: 1024 * 1024 * 10,
			});

			let result = "";
			if (stdout) result += stdout;
			if (stderr) result += `\nSTDERR:\n${stderr}`;

			return result || "Command executed successfully";
		} catch (error: any) {
			return `Command failed: ${error.message}\n${error.stderr || ""}`;
		}
	}
}
