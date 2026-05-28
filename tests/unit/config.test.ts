import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadMiMoConfig, mergeConfig } from '../../src/config/index.js';
import { createMiMoStack } from '../../src/config/createMiMoStack.js';
import { ToolRegistry } from '../../src/tools/ToolRegistry.js';
import { MockClient } from '../../src/mocks/MockClient.js';

describe('loadMiMoConfig', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-cfg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads a native .mimo.json verbatim', async () => {
    fs.writeFileSync(path.join(dir, '.mimo.json'), JSON.stringify({ planMode: true, maxSteps: 7 }));
    const cfg = await loadMiMoConfig(dir);
    expect(cfg.planMode).toBe(true);
    expect(cfg.maxSteps).toBe(7);
  });

  it('translates opencode.json (init output) into MiMoConfig', async () => {
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({
      minimum: { optimization: {
        validation: false, completeness: true,
        context: { foldThreshold: 0.55, aggressiveThreshold: 0.80 },
      } },
    }));
    const merged = mergeConfig(await loadMiMoConfig(dir));
    expect(merged.validation.enabled).toBe(false);
    expect(merged.completeness.enabled).toBe(true);
    expect(merged.context.foldThreshold).toBe(0.55);
    expect(merged.context.aggressiveThreshold).toBe(0.80);
  });

  it('prefers .mimo.json over opencode.json', async () => {
    fs.writeFileSync(path.join(dir, '.mimo.json'), JSON.stringify({ maxSteps: 3 }));
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ minimum: { optimization: {} } }));
    const cfg = await loadMiMoConfig(dir);
    expect(cfg.maxSteps).toBe(3);
  });

  it('returns {} when no config file exists', async () => {
    expect(await loadMiMoConfig(dir)).toEqual({});
  });
});

describe('createMiMoStack', () => {
  it('registers todo_write compatibly with the real ToolRegistry', () => {
    const tools = new ToolRegistry();
    createMiMoStack(new MockClient(), tools, process.cwd(), {});
    expect(tools.has('todo_write')).toBe(true);
    // getDefinitions() invokes tool.getDefinition(); a bad shape would throw here.
    const def = tools.getDefinitions().find((d) => d.name === 'todo_write');
    expect(def?.parameters).toBeDefined();
  });
});
