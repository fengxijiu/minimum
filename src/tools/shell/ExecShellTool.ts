import { spawn } from "node:child_process";
import { truncateToolResult } from "../truncateResult.js";

export class ExecShellTool {
	name = "exec_shell";
	description = "Execute a shell command and return stdout+stderr";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Shell command to execute" },
					timeout: {
						type: "number",
						description: "Timeout in ms (default 30000)",
					},
					cwd: { type: "string", description: "Working directory" },
				},
				required: ["command"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string; signal?: AbortSignal },
	): Promise<string> {
		const cwd = args.cwd || context?.workingDirectory || process.cwd();
		const timeoutMs: number = args.timeout ?? 30_000;
		const { signal } = context ?? {};

		return new Promise<string>((resolve) => {
			const chunks: Buffer[] = [];
			let totalBytes = 0;
			const BUFFER_LIMIT = 10 * 1024 * 1024; // 10 MB hard cap on raw collection

			const proc = spawn("sh", ["-c", args.command], {
				cwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});

			// Kill when parent signals abort
			const onAbort = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* noop */
					}
				}, 500);
			};
			if (signal) {
				if (signal.aborted) {
					proc.kill("SIGTERM");
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// Collect output up to BUFFER_LIMIT
			const collect = (data: Buffer) => {
				if (totalBytes < BUFFER_LIMIT) {
					chunks.push(data);
					totalBytes += data.length;
				}
			};
			proc.stdout.on("data", collect);
			proc.stderr.on("data", collect);

			// Wall-clock timeout
			const timer = setTimeout(() => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* noop */
					}
				}, 500);
			}, timeoutMs);

			proc.on("close", (code) => {
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);

				if (signal?.aborted) {
					resolve("命令已取消");
					return;
				}

				const raw = Buffer.concat(chunks).toString("utf8").trimEnd();
				const output = raw || "(无输出)";
				const withCode = code !== 0 ? `[退出码 ${code}]\n${output}` : output;

				resolve(truncateToolResult(withCode, undefined, "exec_shell"));
			});

			proc.on("error", (err) => {
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve(`命令启动失败: ${err.message}`);
			});
		});
	}
}
