# MCP Usage

Minimum can act as both an MCP client and a local MCP server.

## Local Minimum Server

Run the built-in stdio server:

```bash
minimum-mcp-server
```

It exposes project resources, plan draft tools, persona and skill lookup, GitHub read tools, and gated GitHub write tools.

Useful resources:

- `minimum://project_state`
- `minimum://skills`
- `minimum://personas`
- `minimum://task_plan_drafts`
- `minimum://mcp_registry`
- `minimum://mcp_health`
- `minimum://mcp_audit`

Useful tools:

- `read_project_state`
- `write_task_plan_draft`
- `query_persona`
- `list_skills`
- `validate_plan_draft`
- `suggest_mcp_server_config`
- `github_auth_status`
- `github_repo_info`
- `github_list_prs`
- `github_pr_view`
- `github_issue_view`
- `github_ci_status`

GitHub write tools are present but disabled by default:

- `github_create_pr_draft`
- `github_comment_pr`

Enable them only when needed:

```bash
MINIMUM_MCP_GITHUB_ALLOW_WRITES=true
MINIMUM_MCP_GITHUB_ALLOWED_TOOLS=github_create_pr_draft,github_comment_pr
```

## TUI Commands

Inside the TUI:

```text
/mcp
/mcp health
/mcp audit
/mcp registry
/mcp resources
/mcp read minimum://mcp_audit
/mcp prompts
/mcp prompt minimum.write_task_plan_draft {"task":"add tests","title":"Test plan"}
/plan drafts
/plan preview <draft-id>
/plan import <draft-id>
```

## Config Examples

Examples live under `examples/mcp/`:

- `minimum-stdio.json`
- `github-stdio.json`
- `github-writes-enabled.json`
- `remote-http.json`
- `remote-sse.json`

Keep remote servers on an allowlist. Use `denyTools` for write-capable tools and put secrets in environment variables referenced as `${NAME}`. Minimum expands environment placeholders in stdio `command`, `args`, `env`, remote `url`, and remote `headers`; `${PWD}` and `${CWD}` resolve to the current project directory.

## Audit Log

When MCP calls flow through Minimum, audit entries are written to:

```text
.minimum/mcp/audit.log
```

Entries include timestamp, server, tool/resource/prompt name, argument summary, success/failure, duration, and redacted error text. Tokens, Authorization headers, passwords, secrets, and API keys are redacted.
