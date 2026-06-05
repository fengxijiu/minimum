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

	it("parses ***bold italic*** as strong_emphasis", () => {
		const segments = parseInlineMarkdown("This is ***important*** text.");
		const kinds = segments.map(s => s.kind);
		expect(kinds).toContain("strong_emphasis");
		const se = segments.find(s => s.kind === "strong_emphasis");
		expect(se?.text).toBe("important");
	});

	it("parses ___bold italic___ as strong_emphasis", () => {
		const segments = parseInlineMarkdown("This is ___important___ text.");
		const kinds = segments.map(s => s.kind);
		expect(kinds).toContain("strong_emphasis");
		const se = segments.find(s => s.kind === "strong_emphasis");
		expect(se?.text).toBe("important");
	});

	it("handles emphasis around strong markers without false close", () => {
		const segments = parseInlineMarkdown("*italic **bold** italic*");
		const kinds = segments.map(s => s.kind);
		expect(kinds).toContain("emphasis");
		const em = segments.find(s => s.kind === "emphasis");
		expect(em?.text).toContain("bold");
	});

	it("handles strong with single-star content inside", () => {
		const segments = parseInlineMarkdown("**bold *word* bold**");
		const kinds = segments.map(s => s.kind);
		expect(kinds).toContain("strong");
		const strong = segments.find(s => s.kind === "strong");
		expect(strong?.text).toContain("*word*");
	});
});
