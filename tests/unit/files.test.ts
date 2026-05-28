import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('files', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-files-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scans files and ignores node_modules', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'hi');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    fs.writeFileSync(path.join(dir, 'node_modules', 'foo', 'pkg.json'), '{}');

    const mod = await import('../../tui/src/files.js?scan=' + Date.now());
    const out = mod.scanFiles(dir);
    const names = out.map((f: { name: string }) => f.name).sort();
    expect(names).toContain('README.md');
    expect(names).toContain('src/a.ts');
    expect(names).not.toContain(expect.stringMatching(/node_modules/));
  });

  it('readBranch reads .git/HEAD', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/my-feature\n');
    const mod = await import('../../tui/src/files.js?branch=' + Date.now());
    expect(mod.readBranch(dir)).toBe('my-feature');
  });

  it('readBranch returns no-git outside a repo', async () => {
    const mod = await import('../../tui/src/files.js?branch2=' + Date.now());
    expect(mod.readBranch(dir)).toBe('no-git');
  });

  it('touch promotes existing entry without duplicating', async () => {
    const mod = await import('../../tui/src/files.js?touch=' + Date.now());
    const initial = [
      { name: 'a.ts', meta: '1k' },
      { name: 'b.ts', meta: '2k' },
      { name: 'c.ts', meta: '3k' },
    ];
    const next = mod.touch(initial, { name: 'b.ts', meta: 'edit_file' });
    expect(next.map((f: { name: string }) => f.name)).toEqual(['b.ts', 'a.ts', 'c.ts']);
    expect(next).toHaveLength(3);
  });
});
