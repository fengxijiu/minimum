import { ToolCallRepair } from "../../src/repair/ToolCallRepair";
import type { ToolCall } from "../../src/types/common";
import type {
	RepairContext,
	RepairRequest,
	ToolSchema,
} from "../../src/types/repair";

describe("ToolCallRepair", () => {
	let repair: ToolCallRepair;

	beforeEach(() => {
		repair = new ToolCallRepair();
	});

	describe("repairJson", () => {
		it("should return unchanged for valid JSON", () => {
			const result = repair.repairJson('{"key": "value"}');
			expect(result.changed).toBe(false);
			expect(result.repaired).toBe('{"key": "value"}');
		});

		it("should repair truncated JSON", () => {
			const result = repair.repairJson('{"key": "value"');
			expect(result.changed).toBe(true);
			expect(result.repaired).toBe('{"key": "value"}');
		});

		it("should handle empty input", () => {
			const result = repair.repairJson("");
			expect(result.changed).toBe(true);
			expect(result.repaired).toBe("{}");
		});
	});

	describe("repairArgTypes", () => {
		it("should convert string to number", () => {
			const args = { count: "42" };
			const schema: ToolSchema = {
				name: "test",
				properties: {
					count: { type: "number" },
				},
			};
			const result = repair.repairArgTypes(args, schema);
			expect(result.count).toBe(42);
		});

		it("should convert number to string", () => {
			const args = { name: 123 };
			const schema: ToolSchema = {
				name: "test",
				properties: {
					name: { type: "string" },
				},
			};
			const result = repair.repairArgTypes(args, schema);
			expect(result.name).toBe("123");
		});

		it("should convert string to boolean", () => {
			const args = { enabled: "true" };
			const schema: ToolSchema = {
				name: "test",
				properties: {
					enabled: { type: "boolean" },
				},
			};
			const result = repair.repairArgTypes(args, schema);
			expect(result.enabled).toBe(true);
		});
	});

	describe("repair", () => {
		it("should repair complete tool call", async () => {
			const context: RepairContext = {
				toolSchemas: {
					test: {
						name: "test",
						properties: {
							count: { type: "number" },
							path: { type: "string" },
						},
					},
				},
				projectRoot: "/project",
				workingDirectory: "/project/src",
				readFiles: new Set(),
			};

			const toolCall: ToolCall = {
				type: "function",
				function: {
					name: "test",
					arguments: '{"count": "42", "path": "file.txt"}',
				},
			};

			const request: RepairRequest = {
				toolCall,
				context,
			};

			const result = await repair.repair(request);
			expect(result.repaired).toBe(true);
			expect(result.repairs.length).toBeGreaterThan(0);
		});
	});
});
