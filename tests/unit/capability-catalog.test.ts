import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildGrantableCatalog,
	renderGrantableCatalog,
	validateGrants,
} from "../../src/orchestration/CapabilityCatalog.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-cat-"));
	const learned = path.join(dir, ".minimum", "skills", "learned", "pdf-extract");
	fs.mkdirSync(learned, { recursive: true });
	fs.writeFileSync(
		path.join(learned, "SKILL.md"),
		"---\nid: pdf-extract\n---\n## When to Use\n- Extract text from PDFs\n",
	);
	const denied = path.join(dir, ".minimum", "skills", "learned", "secret-skill");
	fs.mkdirSync(denied, { recursive: true });
	fs.writeFileSync(path.join(denied, "SKILL.md"), "---\n---\n## When to Use\n- secret\n");
	fs.writeFileSync(
		path.join(dir, ".minimum", "skills", "index.json"),
		JSON.stringify({ skills: { "pdf-extract": { triggers: ["pdf"] } } }),
	);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("buildGrantableCatalog", () => {
	it("lists learned skills and MCP tools, minus denylists", async () => {
		const cat = await buildGrantableCatalog({
			projectRoot: dir,
			mcpTools: [
				{ name: "mcp__gh__create_issue", description: "open an issue" },
				{ name: "mcp__gh__delete_repo", description: "danger" },
			],
			denylistSkills: ["secret-skill"],
			denylistMcpTools: ["mcp__gh__delete_repo"],
		});
		expect(cat.skills.map((s) => s.id)).toEqual(["pdf-extract"]);
		expect(cat.skills[0]!.triggers).toEqual(["pdf"]);
		expect(cat.skills[0]!.brief).toContain("Extract text from PDFs");
		expect(cat.mcpTools.map((t) => t.name)).toEqual(["mcp__gh__create_issue"]);
	});

	it("yields a skills-only catalog when no MCP tools are supplied", async () => {
		const cat = await buildGrantableCatalog({
			projectRoot: dir,
			mcpTools: [],
			denylistSkills: [],
			denylistMcpTools: [],
		});
		expect(cat.mcpTools).toEqual([]);
		expect(cat.skills.map((s) => s.id)).toContain("pdf-extract");
	});

	it("renders a non-empty section and an empty marker", async () => {
		const cat = await buildGrantableCatalog({
			projectRoot: dir,
			mcpTools: [],
			denylistSkills: [],
			denylistMcpTools: [],
		});
		expect(renderGrantableCatalog(cat)).toContain("pdf-extract");
		const empty = renderGrantableCatalog({ skills: [], mcpTools: [] });
		expect(empty).toContain("(none)");
	});
});

function contractWith(grantedSkills: string[], grantedMcpTools: string[]): TaskContract {
	return { taskId: "T2-1", grantedSkills, grantedMcpTools } as unknown as TaskContract;
}

describe("validateGrants", () => {
	const catalog = {
		skills: [{ id: "pdf-extract", brief: "", triggers: [] }],
		mcpTools: [{ name: "mcp__gh__create_issue", description: "" }],
	};

	it("passes when every grant is in the catalog", () => {
		expect(validateGrants(contractWith(["pdf-extract"], ["mcp__gh__create_issue"]), catalog)).toEqual([]);
	});

	it("rejects an unknown skill and an unknown tool", () => {
		const errs = validateGrants(contractWith(["ghost-skill"], ["mcp__gh__nope"]), catalog);
		expect(errs.some((e) => e.includes("ghost-skill"))).toBe(true);
		expect(errs.some((e) => e.includes("mcp__gh__nope"))).toBe(true);
	});
});
