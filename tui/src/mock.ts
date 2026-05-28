import type { AppState } from './types.js';

// Static seed state — replace with a real agent stream.
export const initialState: AppState = {
  path: '~/proj/api',
  branch: 'main',
  mode: 'agent',
  approvalMode: 'auto-edit',
  ctx: { used: 24.7, max: 200 },
  files: [
    { name: 'routes.py', meta: '+9', staged: true },
    { name: 'server.py', meta: '+3', staged: true },
    { name: 'tests/test_routes.py', meta: '+12' },
    { name: 'pyproject.toml', meta: '21 ln' },
    { name: 'README.md', meta: 'deploy' },
  ],
  edits: [
    { sign: '+', label: 'routes.py · /health' },
    { sign: '+', label: 'server.py · register' },
    { sign: '~', label: 'tests · test_health' },
  ],
  redo: [],
  plan: {
    title: '/health endpoint',
    steps: [
      { label: 'read routes',      status: 'done' },
      { label: 'draft /health',    status: 'done' },
      { label: 'wire into server', status: 'done' },
      { label: 'add smoke test',   status: 'now'  },
      { label: 'run pytest',       status: 'next' },
    ],
  },
  currentStepLabel: 'STEP 4 · ADD A SMOKE TEST',
  messages: [
    { id: 'u1', type: 'user',
      text: 'add a /health endpoint — uptime + git sha. test it too.' },
    { id: 'a1', type: 'assistant',
      text: "I'll wire the handler into server.py and add a smoke test." },
    { id: 't1', type: 'tool',
      tool: { kind: 'read', args: 'server.py', meta: '48 ln · cached' } },
    { id: 't2', type: 'tool',
      tool: { kind: 'edit', args: 'server.py · @ 12', meta: '+3 −0' } },
    { id: 'd1', type: 'diff', diff: {
      file: 'server.py',
      added: 2, removed: 0,
      lines: [
        '  from .routes import version',
        '+ from .routes import health',
        '  ',
        '  app.register(version)',
        '+ app.register(health)',
      ],
    } },
    { id: 't3', type: 'tool',
      tool: { kind: 'edit', args: 'tests/test_routes.py · @ end', meta: '+12 −0' } },
    { id: 'a2', type: 'assistant',
      text: 'Two edits staged. Run pytest -q next?' },
    { id: 'c1', type: 'chips', chips: [
      { key: '⏎', label: 'run',         primary: true },
      { key: 'n', label: 'pause' },
      { key: 'd', label: 'show diffs' },
      { key: 'e', label: 'edit plan' },
    ] },
  ],
  input: '',
};
