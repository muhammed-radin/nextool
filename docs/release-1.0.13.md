---
title: Release 1.0.13 — THE OPERATOR CONSOLE
category: Reference
order: 0
---

# NexTool Q1 v1.0.13 — THE OPERATOR CONSOLE

Major release on top of v1.0.12. This page documents every major change of the
release; it is the single reference for the product model, environment model,
FS Inspector, MCP authentication, tool runtime interactivity, task-execution
escalation rules and the UI changes.

---

## 0. Product model — ONE self-hosted console, ONE local owner

NexTool is a **single-user self-hosted console**. One installation is owned and
operated by one self-hosting user:

```
One NexTool installation
        │
        └── one self-hosted operator
                 ├── tasks          ├── MCP connectors
                 ├── tools          ├── VFS
                 ├── real FS        ├── models
                 └── settings       └── history
```

It is **not** a multi-user SaaS console. Task state, tools, connectors, MCP
credentials, the VFS, the real filesystem access, models, data, configuration
and history all belong to the local operator. There is deliberately no user
switching, workspace switching or tenant model anywhere in the UI or APIs.
Security boundaries exist for the ENVIRONMENTS (below), not for hypothetical
multi-tenancy.

---

## 19. Environment model (final v1.0.13 rules)

| Environment | Access | Cannot access |
| --- | --- | --- |
| `vfs` (restricted node / js-function) | shared VFS only | real host FS |
| `mcp` (imported MCP tools) | shared VFS only | real host FS — can never escape the VFS (`..`, absolute host paths, symlink escapes are resolved-and-refused server-side) |
| `fs` / `freedom-node` | REAL host filesystem (operator-controlled) | — |

The FS Inspector may inspect the real FS **because the operator explicitly
opened the real-FS inspector** — the console is the operator's own surface on
their own machine.

---

## 2. FS Inspector — full file manager (VFS + real FS)

New console view with a shared environment selector (`VFS ▼ / FS`) and three
internal tabs:

- **Files** — path bar (Go / Up / Root / Refresh), New file, New folder,
  Upload (device → selected environment, per-file 8 MiB cap), Paste
  (copy/cut clipboard), file search **with configurable depth**
  (0 = current directory only, up to 10 levels), listing with multi-selection
  (checkbox, ctrl/cmd-click, shift-range, select all / clear) and bulk actions
  (Copy / Move… / Cut / Duplicate / Download / ZIP / Delete — invalid actions
  are disabled rather than silently failing), per-row action menu (open /
  preview / edit / rename / duplicate / copy path / download / info / delete),
  preview (text, Markdown, JSON, source files, images via data URLs; binary
  files show honest metadata instead of garbage), info dialog (name, path,
  kind, size, created/modified, permissions, environment, MIME, SHA-256 for
  files ≤ 8 MiB).
- **Compress → ZIP** for any selection (files + folders, hierarchy preserved,
  256 MiB archive budget, pure-TypeScript ZIP writer) — returned as a browser
  download or written into a folder.
- **Editors** — internal multi-file editor: multiple tabs, per-tab dirty
  state and unsaved indicator, save (per tab + Ctrl/Cmd+S), close, close all,
  reopen from the Files tab, language detection, **"Use Monaco Editor"
  toggle (default ON, persisted)** — when OFF a plain textarea edits the same
  draft. Both modes are fully functional.
- **Terminal** —
  - FS: multiple real bash sessions (up to 4), command execution with
    stdout / stderr / exit code / running state, 30 s hard timeout, 256 KiB
    output caps, clear, working-directory tracking, environment indicator;
    working directory stays confined to the runtime cwd (same containment
    contract as the file APIs — `..`/symlink escapes refused with
    `FS_ACCESS`).
  - VFS: a **sandboxed virtual shell** (`pwd`, `ls`, `cd`, `cat`, `mkdir`,
    `touch`, `rm`, `cp`, `mv`, `echo … > file`, `find`, `clear`, `help`)
    mapped onto the VFS API — it can never escape the VFS.

APIs: `/api/inspector/vfs` + `/api/inspector/fs` (`GET op=list|read|stat|download`,
`POST op=mkdir|write|rename|delete|copy|move|duplicate|zip|search|info`,
multipart `op=upload`) and `/api/inspector/terminal` (FS only).

---

## 3. Branding / logo fix

The generated icon package is now self-healing: a database reset no longer orphans
the on-disk branding package — `getActiveBranding()` re-activates it by rebuilding
the manifest from the actual files (favicon + IHDR-validated PNG sizes). The layout
metadata hardcodes the CORRECT generated paths as a fallback, a root `/favicon.ico`
exists, and the navbar logo reads the same manifest.

---

## 4/5/8. Super-powered MCP client

- **Connection modes**: Streamable HTTP (server URL) and stdio command mode
  (command / args / env) — provider presets ship both where applicable.
- **Capability discovery** (§4.5): discovery returns tools with full input
  schemas + hashes, **resources, resource templates, prompts and the server's
  declared capability object** (displayed in the Connectors discovery dialog).
- **Customizable authentication** (§5): every provider preset declares its
  auth methods, per-method credential fields, OAuth endpoints, editable
  default scopes, PKCE support, login wording and token-validation strategy
  (`google_tokeninfo` / `github_user` / none). The Connectors page renders a
  method selector per connector:
  - `No authentication`
  - `Access token` / `I got token already (access + refresh)` — method-scoped
    credential fields, best-effort token validation recorded in the status
  - `Login via NexTool: Redirect` — OAuth 2.0 authorization-code flow with
    PKCE where supported: editable scopes (chips + arbitrary scope adder,
    §5.3), **explicit confirmation dialog before ANY external redirect**
    (§5.1: "This connector will open an external authentication page —
    Continue to <provider>?"), server-side single-use state (10 min TTL),
    automatic code→token exchange, credential storage and connector
    association, then return to the console with an honest toast.
  - `Refresh token` action rotates a stored access token via the refresh
    grant (§5.4).
- **Imported-tool identity** (§8): imported tools keep a STABLE NexTool
  registry name plus a `definition.mcp` reference (`connectorId + providerId +
  mcpToolName + remoteHash`). Enable/disable/remove resolve the tool through
  `findImportedTool` (registry name, remote MCP name, or connector-slug
  pattern) — toggling survives page reloads and connector reconnects, and the
  historical `"ask_claude" is not an imported tool of this connector` failure
  mode is fixed at the identity layer (the honest 404 message now lists the
  connector's imported tools).
- **gmail labels** (§6): zero provider names are hardcoded in the console —
  every label comes from connector/provider/server metadata (a missing
  `name` serialization in the connector DTO was found and fixed).

---

## 7. Dynamic model version

All model-version display is derived from `src/lib/nexool/version.ts`
(`CORE_MODULE_VERSION`, `TRAINED_MODEL_VERSION`, `APP_VERSION`). The static
"unchanged since v1.0.0" copy was removed; model pages, Settings and
`/api/system` read the same source of truth.

---

## 9/11. One-by-one termination + Live Preview recovery

- **One-by-one stops after successful verification** — a verified goal is a
  completion latch: the loop returns the `completed` termination immediately
  (no duplicate verification, no extra planner cycle, no safety-limit
  consumption). The verification latch (verification tools hold their result
  open for operator review via `/api/verifications`) auto-verifies after
  5 minutes so an absent operator never stalls the runtime.
- **Live Preview freeze fixed at the event layer** — the SSE hook now
  reconnects with `?since=<newest seen event>` so events emitted during a
  disconnect gap are REPLAYED instead of lost, a connection that stayed live
  >30 s resets the retry budget (no more permanently silent streams), and the
  id-dedup set is bounded. REST state and SSE events merge id-deduped and
  time-ordered; execution snapshots are reconciled so a terminal status never
  regresses.

---

## 13. User denial / tool rejection escalation (one-by-one)

Every approval denial is counted per task with the user's optional reason
(`task.user_denial` events):

| Denial | Runtime behavior |
| --- | --- |
| #1 | Understand the reason → RETRY the same logical state (directive carried in the denied execution) |
| #2 | CHANGE THE PLAN → retry with a modified approach |
| #3 | FINAL plan revision → retry once more |
| #4 | **Task STOPS** — status `stopped`, detail `user_denied: …` |

---

## 14/15/16. Tool runtime interactivity

- **Subtool API** — `await context.tools.call("<tool>", { … })` inside any
  tool environment: parent chain, depth (max 3), shared call budget (20),
  recursion/cycle guards, cancellation threading, observable
  `subtool.started/completed/failed` events, execution visible in the Task
  Preview.
- **`await alert("message")`** — real tool-runtime API (never the browser
  alert): the tool pauses, the console shows the message, the promise
  resolves when the operator acknowledges. 120 s window.
- **`await askForUserAsChoice([...])`** — multiple-choice operator prompt
  with custom-text option: `{ type: "custom" }` entries return the user's
  exact text plus the chosen-mode metadata — custom answers are never forced
  onto a predefined value. Resolved via `/api/choices`.
- **`fs.upload` file requests** — the console shows an "Upload requested"
  card with `[Choose file] [Cancel]`; the chosen file streams (base64) to the
  waiting tool and lands in the shared VFS.

---

## 17. Tool IDE schema form ⇄ JSON sync

One canonical draft (`schemaText`): the JSON view edits it, the structured
form is a projection flushed into it on switch/Save, switching back re-derives
the form from the parsed JSON, invalid JSON keeps the user's exact text (form
goes read-only, Save disabled) and never silently overwrites it.

---

## 18. Safety-limit continuation

When a task reaches its iteration / tool-call / timeout budget, the operator
gets: *"Safety limit reached. Continue task with extended limits? [Stop]
[Continue]"* (`/api/limits/continuations`).

- Continue → extends the CURRENT task's budget (e.g. iterations 30 → 60,
  timeout 120 s → 240 s); global Settings are never mutated.
- Stop → task ends as `limit_reached`.
- The request expires after **60 seconds** of no response → task stops.
- Per-task continuation cap (0–5, default 1) configured in the Task Console.

---

## 21/22. Versioning & docs

Application version is **1.0.13** everywhere (`package.json`,
`version.ts`, `/api/system`, Settings, Dashboard). The model version remains
dynamically sourced (llm-core 1.0.0 provider-served; trained classifier
generation 1.0.3) and is NOT bumped by an application release.

---

## 28. Post-release polish — branding + FS Inspector mobile (operator feedback)

Follow-up round after the initial v1.0.13 drop, fixing the issues found in
real use:

### 28.1 Logo / branding — the shipped icon pack is applied

- The previously referenced generated package contained **placeholder
  solid-color tiles**, and `/logo.svg` was a foreign mark — the navbar, tab
  favicon and OS icons all rendered a blank tile. The real icon pack
  (`favicon_io.zip`: favicon.ico 16/32/48 multi-layer, favicon-16/32,
  android-chrome-192/512, apple-touch-icon 180) is now staged through
  `POST /api/icons` (canonical-name aliases validated against real PNG
  IHDR dimensions) and **activated** via `PATCH /api/icons` — the same
  flow the Settings → Branding UI drives.
- `public/favicon.ico` is synced from the active package; the metadata
  fallback paths in `layout.tsx` point at the shipped package
  (`/icons/icons-muy8s37a/`); the obsolete placeholder package was removed
  with zero stale references.
- BrandLogo picks the best square PNG from the live manifest, so navbar and
  mobile header show the real logo without any hardcoding.

### 28.2 FS Inspector — mobile design fixes (§2.9)

1. **Environment card overlay** — on narrow screens the environment label,
   selector, environment badge and the VFS usage snapshot competed for one
   row and overlapped. The card is now a **column on mobile** (selector row →
   badge row → usage row under a hairline divider) and returns to a single
   row at `sm:` and up.
2. **Tabs container vs. active-tab height** — the full-width mobile tab grid
   is `h-11` so the triggers (`h-[calc(100%-1px)]`) and the active highlight
   never overflow the container; `sm:` and up restore the compact `h-9` pill
   with `w-fit` + `self-start` so the flex-col parent can no longer stretch
   the list edge-to-edge.
3. **Inactive panel bleed-through** — the Editors panel used Radix
   `forceMount` (to keep editor state alive) which never applies `hidden`
   itself; the editor and terminal panels rendered **simultaneously** on the
   Terminal tab. Fixed with `data-[state=inactive]:hidden`.
4. **Render-phase session creation** — the VFS shell session was created via
   an inline `setSessions` call inside JSX (StrictMode hazard); it now lives
   in the mode-switch effect with an idempotent guard.
5. **Touch & density** — row action buttons are 36 px targets, toolbar
   labels collapse below 420 px (icon + environment suffix remain), the KIND
   column hides below `sm` with an inline `dir/`/`file` prefix, listing is
   55 vh tall on mobile, terminal output 50 vh.

### 28.3 Dynamic labels

The FS Inspector description no longer hardcodes the release number — it
renders `v${APP_VERSION}` from `version.ts`, keeping §7's dynamic-version
contract intact across the whole console.
