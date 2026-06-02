import type { JobReadResult, JobRecord, JobStartResult } from "./JobRegistry.js";

export function formatJobStart(r: JobStartResult): string {
	const header = r.stillRunning
		? `[job ${r.jobId} started · pid ${r.pid ?? "?"} · ${r.readyMatched ? "READY signal matched" : "running (no ready signal yet)"}]`
		: r.exitCode !== null
			? `[job ${r.jobId} exited during startup · exit ${r.exitCode}]`
			: `[job ${r.jobId} failed to start]`;
	return r.preview ? `${header}\n${r.preview}` : header;
}

export function formatJobRead(jobId: number, r: JobReadResult): string {
	const status = r.running
		? `running · pid ${r.pid ?? "?"}`
		: r.exitCode !== null
			? `exited ${r.exitCode}`
			: r.spawnError
				? `failed (${r.spawnError})`
				: "stopped";
	const header = `[job ${jobId} · ${status} · byteLength=${r.byteLength}]\n$ ${r.command}`;
	return r.output ? `${header}\n${r.output}` : header;
}

export function formatJobStop(r: JobRecord): string {
	const running = r.running
		? "still running (SIGKILL may be pending)"
		: `exit ${r.exitCode ?? "?"}`;
	const tail = tailLines(r.output, 40);
	const header = `[job ${r.id} stopped · ${running}]\n$ ${r.command}`;
	return tail ? `${header}\n${tail}` : header;
}

export function formatJobRow(r: JobRecord): string {
	const age = ((Date.now() - r.startedAt) / 1000).toFixed(1);
	const state = r.running
		? `running   ·  pid ${r.pid ?? "?"}`
		: r.exitCode !== null
			? `exit ${r.exitCode}`
			: r.spawnError
				? "failed"
				: "stopped";
	return `  ${String(r.id).padStart(3)}  ${state.padEnd(24)}  ${age}s ago   $ ${r.command}`;
}

export function tailLines(s: string, n: number): string {
	if (!s) return "";
	const lines = s.split("\n");
	if (lines.length <= n) return s;
	const dropped = lines.length - n;
	return [`[… ${dropped} earlier lines …]`, ...lines.slice(-n)].join("\n");
}
