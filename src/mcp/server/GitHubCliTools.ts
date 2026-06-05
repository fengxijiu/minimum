import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitHubToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export interface GitHubWritePolicy {
	allowWrites?: boolean;
	allowedTools?: readonly string[];
}

export async function callGitHubTool(
	name: string,
	args: Record<string, unknown>,
	cwd: string,
	writePolicy: GitHubWritePolicy = {},
): Promise<GitHubToolResult> {
	try {
		switch (name) {
			case "github_auth_status":
				return textResult(await ghText(["auth", "status"], cwd));
			case "github_repo_info":
				return jsonTextResult(await ghJson([
					"repo",
					"view",
					"--json",
					"nameWithOwner,description,url,defaultBranchRef,isPrivate",
				], cwd));
			case "github_list_prs":
				return jsonTextResult(await ghJson([
					"pr",
					"list",
					"--state",
					stringArg(args.state, "open"),
					"--limit",
					String(numberArg(args.limit, 20)),
					"--json",
					"number,title,state,author,url,headRefName,baseRefName,isDraft,updatedAt",
				], cwd));
			case "github_pr_view":
				return jsonTextResult(await ghJson([
					"pr",
					"view",
					requiredString(args.number ?? args.pr, "number"),
					"--json",
					"number,title,state,author,url,body,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup",
				], cwd));
			case "github_issue_view":
				return jsonTextResult(await ghJson([
					"issue",
					"view",
					requiredString(args.number ?? args.issue, "number"),
					"--json",
					"number,title,state,author,url,body,labels,assignees,comments",
				], cwd));
			case "github_ci_status":
				return jsonTextResult(await ghJson([
					"run",
					"list",
					"--limit",
					String(numberArg(args.limit, 10)),
					"--json",
					"databaseId,displayTitle,status,conclusion,workflowName,headBranch,createdAt,url",
				], cwd));
			case "github_create_pr_draft":
				if (!canWrite(name, writePolicy)) return writeDenied(name);
				return textResult(await ghText([
					"pr",
					"create",
					"--draft",
					"--title",
					requiredString(args.title, "title"),
					"--body",
					requiredString(args.body, "body"),
					...(typeof args.base === "string" && args.base.trim() ? ["--base", args.base.trim()] : []),
					...(typeof args.head === "string" && args.head.trim() ? ["--head", args.head.trim()] : []),
				], cwd));
			case "github_comment_pr":
				if (!canWrite(name, writePolicy)) return writeDenied(name);
				return textResult(await ghText([
					"pr",
					"comment",
					requiredString(args.number ?? args.pr, "number"),
					"--body",
					requiredString(args.body, "body"),
				], cwd));
			default:
				return errorResult(`Unknown GitHub MCP tool: ${name}`);
		}
	} catch (error) {
		return errorResult(redactSecrets(String((error as Error)?.message ?? error)));
	}
}

export const GITHUB_READ_TOOL_NAMES = [
	"github_auth_status",
	"github_repo_info",
	"github_list_prs",
	"github_pr_view",
	"github_issue_view",
	"github_ci_status",
] as const;

export const GITHUB_WRITE_TOOL_NAMES = [
	"github_create_pr_draft",
	"github_comment_pr",
] as const;

export const GITHUB_TOOL_NAMES = [
	...GITHUB_READ_TOOL_NAMES,
	...GITHUB_WRITE_TOOL_NAMES,
] as const;

async function ghText(args: string[], cwd: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync("gh", args, {
		cwd,
		timeout: 30_000,
		maxBuffer: 2 * 1024 * 1024,
		windowsHide: true,
	});
	return redactSecrets([stdout, stderr].filter(Boolean).join("\n").trim());
}

async function ghJson(args: string[], cwd: string): Promise<unknown> {
	const out = await ghText(args, cwd);
	return out ? JSON.parse(out) as unknown : {};
}

function textResult(text: string): GitHubToolResult {
	return { content: [{ type: "text", text: text || "(empty)" }] };
}

function jsonTextResult(value: unknown): GitHubToolResult {
	return textResult(JSON.stringify(value, null, 2));
}

function errorResult(text: string): GitHubToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function writeDenied(name: string): GitHubToolResult {
	return errorResult(`GitHub write tool disabled by configuration: ${name}`);
}

function canWrite(name: string, policy: GitHubWritePolicy): boolean {
	return policy.allowWrites === true && (!policy.allowedTools?.length || policy.allowedTools.includes(name));
}

function stringArg(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function requiredString(value: unknown, name: string): string {
	const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
	if (!text) throw new Error(`missing required argument: ${name}`);
	return text;
}

function numberArg(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : fallback;
}

function redactSecrets(text: string): string {
	return text
		.replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
