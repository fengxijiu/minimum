import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('inputHistory', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-hist-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
  });

  it('returns [] when no history file exists', async () => {
    const mod = await import('../../tui/src/inputHistory.js?empty=' + Date.now());
    expect(mod.loadHistory()).toEqual([]);
  });

  it('round-trips entries via append + load', async () => {
    const mod = await import('../../tui/src/inputHistory.js?roundtrip=' + Date.now());
    mod.appendHistory('hello');
    mod.appendHistory('world');
    const out = mod.loadHistory();
    expect(out.map((e: { text: string }) => e.text)).toEqual(['hello', 'world']);
  });

  it('ignores empty input', async () => {
    const mod = await import('../../tui/src/inputHistory.js?empty2=' + Date.now());
    mod.appendHistory('   ');
    mod.appendHistory('');
    expect(mod.loadHistory()).toEqual([]);
  });

  it('skips malformed lines in the history file', async () => {
    const dir = path.join(home, '.minimum');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'history.jsonl'),
      '{"text":"good","ts":1}\nnot-json\n{"text":"also good","ts":2}\n',
    );
    const mod = await import('../../tui/src/inputHistory.js?malformed=' + Date.now());
    const out = mod.loadHistory();
    expect(out.map((e: { text: string }) => e.text)).toEqual(['good', 'also good']);
  });
});
