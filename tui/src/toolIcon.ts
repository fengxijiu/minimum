const MAP: Record<string, string> = {
  read_file:      '◇',
  read:           '◇',
  list_directory: '▤',
  write_file:     '◆',
  edit_file:      '◆',
  edit:           '◆',
  apply_patch:    '◆',
  exec_shell:     '▶',
  run:            '▶',
  grep:           '⌕',
  glob:           '⌕',
  find:           '⌕',
  search:         '⌕',
  web_fetch:      '⊕',
  git:            '⑂',
  git_status:     '⑂',
  git_diff:       '⑂',
  git_log:        '⑂',
  todo_write:     '◉',
  todo_read:      '◈',
};

export function toolIcon(name: string): string {
  return MAP[name] ?? '◇';
}
