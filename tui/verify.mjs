// Headless render-verification harness for the TUI.
// Renders each interaction-critical component through ink-testing-library and
// asserts it produces stable, non-empty output without throwing. This is a
// smoke/contract check, not a pixel test — it catches crashes, undefined
// glyphs, and gross layout regressions across the goal's interaction surface:
// rendering, command selection, file picker, permission card, mode/status.
import React from 'react';
import { render } from 'ink-testing-library';

const results = [];
function check(name, el, expectSubstrings = []) {
  try {
    const { lastFrame, unmount } = render(el);
    const frame = lastFrame() ?? '';
    const ok = frame.trim().length > 0 && expectSubstrings.every(s => frame.includes(s));
    results.push({ name, ok, missing: expectSubstrings.filter(s => !frame.includes(s)) });
    unmount();
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
  }
}

const { CommandPalette } = await import('./dist/components/CommandPalette.js');
const { FilePicker }     = await import('./dist/components/FilePicker.js');
const { PermissionCard, DiffBlock, ToolLine } = await import('./dist/components/atoms.js');
const { StatusBar }      = await import('./dist/components/StatusBar.js');
const { TitleBar }       = await import('./dist/components/TitleBar.js');
const { WelcomeScreen }  = await import('./dist/components/WelcomeScreen.js');
const { HelpOverlay }    = await import('./dist/components/HelpOverlay.js');
const { PlanStrip }      = await import('./dist/components/PlanStrip.js');
const { filterCommands, filterFiles } = await import('./dist/commands.js');

const h = React.createElement;

// 1. Command palette — full list, filtered list, and empty (no-match) state.
//    All three must render at a STABLE height (the keystroke-stability fix).
const allCmds = filterCommands('/');
check('CommandPalette/full',  h(CommandPalette, { items: allCmds, selected: 0 }), ['/ commands']);
check('CommandPalette/one',   h(CommandPalette, { items: filterCommands('/he'), selected: 0 }), ['/ commands']);
check('CommandPalette/empty', h(CommandPalette, { items: [], selected: 0 }), ['no matches']);

// Height stability: full vs filtered vs empty must be the same number of rows.
function rows(el) { const { lastFrame, unmount } = render(el); const n = (lastFrame() ?? '').split('\n').length; unmount(); return n; }
const rFull  = rows(h(CommandPalette, { items: allCmds, selected: 0 }));
const rOne   = rows(h(CommandPalette, { items: filterCommands('/he'), selected: 0 }));
const rEmpty = rows(h(CommandPalette, { items: [], selected: 0 }));
results.push({ name: `CommandPalette/stable-height (${rFull}/${rOne}/${rEmpty})`, ok: rFull === rOne && rOne === rEmpty });

// 2. File picker — populated + stable height.
const files = [
  { name: 'src/app.tsx', meta: 'edit' }, { name: 'src/cli.tsx', meta: 'read' },
  { name: 'README.md', meta: '' },
];
const fAll = filterFiles(files, '');
check('FilePicker/full',  h(FilePicker, { items: fAll, selected: 0 }), ['@ files']);
check('FilePicker/empty', h(FilePicker, { items: [], selected: 0 }), ['no matches']);
const fpFull  = rows(h(FilePicker, { items: fAll, selected: 0 }));
const fpOne   = rows(h(FilePicker, { items: filterFiles(files, 'app'), selected: 0 }));
const fpEmpty = rows(h(FilePicker, { items: [], selected: 0 }));
results.push({ name: `FilePicker/stable-height (${fpFull}/${fpOne}/${fpEmpty})`, ok: fpFull === fpOne && fpOne === fpEmpty });

// 3. Permission card — the permission-selection surface.
check('PermissionCard', h(PermissionCard, { perm: {
  tool: 'exec_shell', cmd: '$ rm -rf build', cwd: '/repo',
  note: 'destructive', risk: 'high', details: ['command: rm -rf build'],
}}), ['TOOL', 'allow', 'deny']);

// 4. Status bar across every session state (mode-switching surface).
for (const st of ['agent', 'mimo', 'orchestrate', 'paused', 'error']) {
  check(`StatusBar/${st}`, h(StatusBar, {
    state: st, approvalMode: 'auto-edit', editMode: 'review',
    ctxUsed: 12.5, ctxMax: 200, hint: '3msg', usage: { lastTurnCost: 0.01, sessionCost: 0.2 },
  }), []);
}

// 5. Static chrome.
check('TitleBar',      h(TitleBar, { path: '/repo', branch: 'main', mode: 'agent' }), ['minimum']);
check('WelcomeScreen', h(WelcomeScreen, { path: '~', engine: { mode: 'engine', model: 'mimo' } }), ['QUICK START']);
check('HelpOverlay',   h(HelpOverlay, {}), ['help']);
check('PlanStrip',     h(PlanStrip, { title: 'plan', steps: [
  { label: 'scan', status: 'done' }, { label: 'edit', status: 'now' }, { label: 'test', status: 'next' },
]}), ['PLAN']);

// 6. Tool line + diff (output rendering).
check('ToolLine/ok',  h(ToolLine, { tool: { kind: 'run', args: 'pytest', status: 'ok', meta: 'exit 0' } }), []);
check('ToolLine/err', h(ToolLine, { tool: { kind: 'run', args: 'pytest', status: 'err', meta: 'exit 1' } }), []);
check('DiffBlock',    h(DiffBlock, { diff: { file: 'a.ts', added: 2, removed: 1, lines: ['@@ -1 +1 @@', '-old', '+new', '+more'] } }), ['a.ts']);

let pass = 0, fail = 0;
for (const r of results) {
  if (r.ok) { pass++; console.log(`  ✓ ${r.name}`); }
  else { fail++; console.log(`  ✗ ${r.name}${r.error ? ` — ${r.error}` : ''}${r.missing?.length ? ` — missing ${JSON.stringify(r.missing)}` : ''}`); }
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
