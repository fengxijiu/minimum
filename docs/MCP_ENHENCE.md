下面是一个完整的后续增强计划，重点是把 MCP 从“能连接工具”推进到“可控地接入真实工作流”，并加入 GitHub CLI 与 GitHub skills。

## MCP 增强完整计划

### Summary
- 增强 MCP 的实际工作流价值：TUI 可导入 MCP 写入的 plan draft，MCP resources/prompts 可查看和使用。
- 增加 MCP tool allowlist、auth headers、审计日志，保证远程工具可控。
- 接入 GitHub CLI：通过 `gh` 提供只读 GitHub tools，并预留显式开启的写操作。
- 增加 GitHub workflow skills：PR review、fix CI、address comments、create PR、release notes。

### Key Changes

**1. Plan Draft 接入 TUI**
- 新增命令：
  - `/plan drafts`
  - `/plan preview <draftId>`
  - `/plan import <draftId>`
  - `/plan reject <draftId>`
- MCP 的 `write_task_plan_draft` 写入 `.minimum/plans/drafts/<draftId>.json` 后，TUI 能读取并导入为当前计划。
- 导入只影响 TUI plan 状态，不自动执行任务。

**2. MCP Resources / Prompts 入口**
- 新增命令：
  - `/mcp resources`
  - `/mcp read <uri>`
  - `/mcp prompts`
  - `/mcp prompt <name> [jsonArgs]`
- 支持查看：
  - `minimum://project_state`
  - `minimum://skills`
  - `minimum://personas`
  - `minimum://task_plan_drafts`

**3. MCP Tool Allowlist**
- `mcpServers` 支持工具过滤：
  ```json
  {
    "name": "github",
    "transport": "http",
    "url": "http://127.0.0.1:7331/mcp",
    "tools": ["github_auth_status", "github_repo_info", "github_pr_view"]
  }
  ```
- 未配置时默认暴露全部工具。
- 配置后只注册 allowlist 中的工具。

**4. Auth Headers**
- remote MCP 支持 headers：
  ```json
  {
    "name": "remote-github",
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${GITHUB_TOKEN}"
    }
  }
  ```
- 支持环境变量展开。
- `/mcp` 不显示 header 内容，只显示 header keys。

**5. GitHub CLI MCP Tools**
- 在 internal `minimum-mcp-server` 增加 GitHub tools，底层调用 `gh`，不直接重写 GitHub API。
- 默认只读：
  - `github_auth_status`
  - `github_repo_info`
  - `github_list_prs`
  - `github_pr_view`
  - `github_issue_view`
  - `github_ci_status`
- 可选写操作，默认关闭：
  - `github_create_pr_draft`
  - `github_comment_pr`
- 写操作必须通过配置开启：
  ```json
  {
    "github": {
      "allowWrites": true,
      "allowedTools": ["github_create_pr_draft", "github_comment_pr"]
    }
  }
  ```

**6. GitHub Skills**
- 增加内置 skills：
  - `github-pr-review`
  - `github-fix-ci`
  - `github-address-comments`
  - `github-create-pr`
  - `github-release-notes`
- 这些 skills 负责给 agent 明确工作流：
  - 先检查 `gh auth status`
  - 再读取 repo/PR/CI 状态
  - 默认只生成计划或草稿
  - 写操作必须确认或配置允许

**7. Safety / Audit**
- 所有 `gh` 命令用参数数组执行，不拼 shell 字符串。
- 不打印 token。
- 对 stdout/stderr 做基础 secret redaction。
- 增加 `.minimum/mcp/audit.log`，记录：
  - server
  - tool
  - timestamp
  - args 摘要
  - success/failure
  - duration

### Implementation Order
1. 实现 `/plan drafts/preview/import/reject`。
2. 实现 `/mcp resources/read/prompts/prompt`。
3. 增加 MCP `tools` allowlist 和 remote `headers`。
4. 增加 GitHub CLI runner 抽象与只读 GitHub tools。
5. 增加 GitHub skills。
6. 增加写操作开关与审计日志。
7. 更新 README 和 examples。

### Test Plan
- MCP：
  - stdio/SSE/http 继续通过。
  - allowlist 只注册指定 tools。
  - headers 支持 env 展开，且 `/mcp` 不泄露值。
- Plan draft：
  - MCP 写入 draft。
  - TUI 能 list/preview/import/reject。
  - 非法 id/path 被拒绝。
- GitHub CLI：
  - mock `gh` 未安装。
  - mock 未登录。
  - repo info / PR view / CI status 成功。
  - 写工具默认拒绝。
  - `allowWrites` 后才允许 draft PR/comment。
- Skills：
  - `/skill list` 包含 GitHub skills。
  - `/skill run github-fix-ci` 生成正确 workflow prompt。
- 验证：
  - `npx vitest run tests/unit/mcp.test.ts tests/integration/mcp-transports.test.ts`
  - `npx vitest run tests/unit/tui-plan-drafts.test.ts tests/unit/github-mcp-tools.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - `cd tui; npm run verify`
  - `git diff --check -- README.md src tui/src bin package.json tests`

### Acceptance Criteria
- MCP 写入的 plan draft 可以在 TUI 中导入。
- `/mcp` 能查看 tools、resources、prompts、失败原因。
- remote MCP 可以配置 headers 和 tool allowlist。
- GitHub 只读 tools 可通过 MCP 调用。
- GitHub 写 tools 默认不可用，必须显式开启。
- GitHub skills 能指导 agent 使用 `gh` 完成 PR review / CI repair / PR creation workflow。