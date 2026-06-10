import { describe, expect, it } from "vitest";
import { ResourceManager } from "../../src/orchestration/ResourceManager.js";

describe("ResourceManager — skipWriteLocks flag", () => {
  it("allows overlapping globs when skipWriteLocks is true", () => {
    const rm = new ResourceManager({ skipWriteLocks: true });

    const r1 = rm.acquire("task-1", "code_writer", ["src/**"], false, false);
    expect(r1.ok).toBe(true);

    // task-2 has same glob — normally blocked, skipWriteLocks bypasses it
    const r2 = rm.acquire("task-2", "code_writer", ["src/**"], false, false);
    expect(r2.ok).toBe(true);

    rm.release("task-1", "code_writer", false, false);
    rm.release("task-2", "code_writer", false, false);
  });

  it("blocks overlapping globs when skipWriteLocks is false (default behaviour)", () => {
    const rm = new ResourceManager({ skipWriteLocks: false });

    const r1 = rm.acquire("task-1", "code_writer", ["src/**"], false, false);
    expect(r1.ok).toBe(true);

    const r2 = rm.acquire("task-2", "code_writer", ["src/**"], false, false);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      const types = r2.reasons.map((r) => r.type);
      expect(types).toContain("write_lock");
    }

    rm.release("task-1", "code_writer", false, false);
  });
});
