import { describe, expect, it } from "vitest";
import { ResourceManager } from "../../src/orchestration/ResourceManager.js";

describe("ResourceManager — global concurrency cap", () => {
  it("defaults the global cap to 50 and blocks the 51st task", () => {
    const rm = new ResourceManager({ skipWriteLocks: true });
    // 50 distinct personas so per-persona caps never bind before the global cap.
    for (let i = 0; i < 50; i++) {
      const r = rm.acquire(`task-${i}`, `persona-${i}`, [], false, false);
      expect(r.ok).toBe(true);
    }
    const overflow = rm.acquire("task-overflow", "persona-overflow", [], false, false);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.reasons.map((r) => r.type)).toContain("global_concurrency");
    }
  });

  it("reports activeCount as the single source of truth for live tasks", () => {
    const rm = new ResourceManager({ skipWriteLocks: true });
    rm.acquire("t1", "p", [], false, false);
    rm.acquire("t2", "p2", [], false, false);
    expect(rm.activeCount).toBe(2);
    rm.release("t1", "p", false, false);
    expect(rm.activeCount).toBe(1);
  });
});

describe("ResourceManager — shell & install gating", () => {
  it("serialises install-dependency tasks via the global install lock", () => {
    const rm = new ResourceManager({ skipWriteLocks: true });
    const a = rm.acquire("t1", "p1", [], false, true);
    expect(a.ok).toBe(true);
    const b = rm.acquire("t2", "p2", [], false, true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reasons.map((r) => r.type)).toContain("install_lock");
    rm.release("t1", "p1", false, true);
    const c = rm.acquire("t3", "p3", [], false, true);
    expect(c.ok).toBe(true);
  });

  it("caps concurrent shell tasks at shellMax", () => {
    const rm = new ResourceManager({ skipWriteLocks: true, shellMax: 1 });
    const a = rm.acquire("t1", "p1", [], true, false);
    expect(a.ok).toBe(true);
    const b = rm.acquire("t2", "p2", [], true, false);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reasons.map((r) => r.type)).toContain("shell_concurrency");
  });
});

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
