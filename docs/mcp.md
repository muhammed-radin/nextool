---
title: MCP Connectors
category: Tools
order: 4
---

# MCP Connectors — external capability over the Model Context Protocol

NexTool v1.0.12 adds a complete **MCP client** (Model Context Protocol). NexTool connects to external MCP servers — such as Gmail, Google Calendar, Google Drive and GitHub — discovers their tools, imports selected tools as native NexTool tools, and executes them through the normal task pipeline.

```
SUPPORTED MCP SERVERS  →  JSON registry  →  CONNECTORS UI  →  MCP CLIENT  →  MCP server
```

## Architecture

| Piece | Location | Responsibility |
| --- | --- | --- |
| Provider registry | `config/mcp-servers.json` + `src/lib/nexool/mcp/provider-registry.ts` | Declarative list of supported MCP servers (transport, auth, config fields). Add a provider by editing the JSON — no runtime code changes. |
| MCP client | `src/lib/nexool/mcp/client.ts` | Official `@modelcontextprotocol/sdk` client. Transport-agnostic `McpClientLike` surface; test-swappable factory. |
| Connector manager | `src/lib/nexool/mcp/connector-manager.ts` | DB-backed state machine: connector CRUD, server-side credentials, connect/disconnect/reconnect, discovery, import, refresh. |
| Schema conversion | `src/lib/nexool/mcp/schema-convert.ts` | Converts MCP `inputSchema` (JSON Schema) into NexTool tool schemas, preserving types, required, descriptions, enums, defaults. |
| MCP runner | `src/lib/nexool/tools/mcp-runner.ts` | Executes an imported tool through its connector and maps failures to NexTool structured tool failures. |
| REST API | `src/app/api/connectors/**` | `/api/connectors` (+ `/[id]`, `/[id]/connection`, `/[id]/credentials`, `/[id]/tools`). |
| UI | `src/components/console/views/connectors.tsx` | The Connectors page. |

Protocol handling stays inside `mcp/client.ts` — the native tool executor is untouched; imported MCP tools simply register an `mcp` handler in the tool registry.

## Supported servers (registry)

| id | Transport | Auth | Required credential fields |
| --- | --- | --- | --- |
| `gmail` | stdio | oauth | `clientId`, `clientSecret` |
| `google-calendar` | stdio | oauth | `clientId`, `clientSecret` |
| `google-drive` | stdio | oauth | `clientId`, `clientSecret` |
| `github` | http | api_token | `token` |

New providers: append an entry to `config/mcp-servers.json` (id, name, description, transport, authentication, config fields, enabled) and restart the runtime.

## Connectors page

The Connectors page (sidebar → **Connectors**) is the single management surface for MCP:

- **Create connector** — pick a provider, name it, set non-secret config (command / URL).
- **Authenticate** — provider-specific credential form (values stored server-side only).
- **Connect / Disconnect / Reconnect** — with a live status model: `not_connected`, `connecting`, `auth_required`, `connected`, `disconnected`, `error`, `reconnecting`.
- **Discover tools** — initialize handshake → `listTools`; each remote tool shows name, description, raw input schema, hash and whether it is already imported.
- **Select & import** — multi-select checkboxes then *Import selected tools*.
- **Manage imported tools** — per connector: enable/disable, refresh schema, remove.

The Tools page continues to manage NexTool-native/custom tools only.

## Authentication & credential security (§1.6/§1.7)

- Auth type is declared **per provider** (`oauth`, `access_token`, `api_token`, `api_key`) — never assumed uniform.
- Credential values are stored **server-side** (Prisma `McpCredential`) and are injected into the transport by the provider's declared mechanism (`env` or `header`).
- The API never returns credential values — only presence info (`hasCredentials`, `credentialFieldsProvided`, `missingRequiredFields`).
- Credentials never appear in logs, tool definitions, or exports.

## Tool discovery & import (§1.9–§1.14)

1. Connect the connector.
2. *Discover tools* — the server's tools are listed with their raw JSON Schemas.
3. Select tools and import — NexTool creates tools with `environment: "mcp"` and names like `mcp.github.search_repositories`.
4. Imported definitions carry **identity only** (`connectorId`, `mcpToolName`, converted schema) — never credentials. The runtime resolves credentials through the connector at execution time.

## Execution (§1.12/§1.18)

When the planner selects an imported MCP tool, the executor calls the `mcp` handler → connector session → MCP server. It participates in the normal execution lifecycle (execution ID, start/running/completed/failed, result, error, duration) and emits the usual tool events.

Failure mapping: authentication failure → `MCP_AUTH_REQUIRED`; unreachable server → `MCP_CONNECTION_FAILED`; remote `isError` result → `MCP_REMOTE_FAILURE`; disconnected connector → `MCP_NOT_CONNECTED`; timeouts and protocol errors are bounded and never crash the task runtime — the step fails structurally like any native tool.

## Disconnect / reconnect (§1.17)

Disconnecting keeps every imported tool record. The tools simply become **unavailable** (calls fail with `MCP_NOT_CONNECTED`) until the connector reconnects — no re-import needed. Reconnecting restores availability automatically.

## Schema refresh (§1.16)

MCP servers can change their tool schemas. *Refresh tools* re-reads the live schemas, diffs against the stored representations and updates them **without destroying local metadata** (enabled state and locally customized descriptions are preserved). A remote tool that disappeared is reported as *unavailable* — its local record is never silently deleted.

## Export policy

MCP tools are connector-backed: they **cannot be exported** (`Export unavailable`), because their identity only makes sense together with their server and exports must never contain connection data. Only custom-created tools are exportable — see [Tools](/docs/tools).

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `auth_required` | Credentials missing/invalid | Set credentials on the Connectors page, reconnect. |
| `error: connection refused` | Server unreachable | Check the transport URL/command; verify network. |
| `MCP_NOT_CONNECTED` during a task | Connector dropped | Reconnect from the Connectors page; task step can be retried. |
| Tool missing after refresh | Remote tool removed | Expected — the local record stays until you remove it. |
| Duplicate import names | Same tool name imported twice | The registry suffixes `-2`, `-3`, … automatically. |
