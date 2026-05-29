import { describe, expect, it } from "vitest";
import { parseInlineMarkdown, parseMarkdown } from "../../tui/src/markdown.js";

describe("TUI markdown parser", () => {
	it("parses common block-level markdown", () => {
		const blocks = parseMarkdown([
			"# Title",
			"",
			"- **bold** item",
			"1. ordered item",
			"> quoted text",
			"```ts",
			"const x = 1;",
			"```",
		].join("\n"));

		expect(blocks.map(block => block.type)).toEqual([
			"heading",
			"list_item",
			"list_item",
			"quote",
			"code",
		]);
	});

	it("parses inline emphasis, strong, and code spans", () => {
		const segments = parseInlineMarkdown("Use **bold**, *em*, and `code`.");
		expect(segments.map(segment => segment.kind)).toContain("strong");
		expect(segments.map(segment => segment.kind)).toContain("emphasis");
		expect(segments.map(segment => segment.kind)).toContain("code");
	});
});
