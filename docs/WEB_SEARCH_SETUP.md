# Web Search (web_searcher persona)

The `web_searcher` persona finds external knowledge via a **web-search MCP
server**. It has no built-in search; you must configure one MCP server that
exposes a search tool. Recommended: **OneSearch MCP** (backed by the DuckDuckGo
MCP Server and DDGS MCP).

## 1. Add the MCP server to your config

In your MiMo config (`mcpServers`), add an entry. The server `name` you choose
becomes the tool prefix `mcp__<name>__…`:

```jsonc
{
  "mcpServers": [
    {
      "name": "onesearch",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "one-search-mcp"]
    }
  ]
}
```

`web_searcher`'s allowlist includes `mcp__*`, so it will pick up the server's
tools regardless of the exact name you choose.

## 2. (Optional) Restrict what is grantable/usable

`web_searcher` is read-only and cannot write or run shell commands. If you want
to keep its MCP surface minimal, name only search-oriented MCP servers in your
config, or add unwanted tool names to `capabilityGrants.denylistMcpTools`.

## 3. Verify

Start the orchestrator and run a task that needs current external info (e.g.
"summarize the latest API for library X"). The master should emit a P0
`web_searcher` task; its brief shows `mcp__onesearch__…` and `web_fetch` calls.

If no search MCP tool is connected, `web_searcher` reports that search is
unavailable instead of fabricating results.
