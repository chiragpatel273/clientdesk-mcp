---
name: add-mcp-tool
description: Add a new MCP tool to ClientDesk the safe way (access check, audit, annotations, schemas, tests). Use whenever a new tool is requested or an existing tool's inputs or outputs change.
---

# Add an MCP tool

Follow every step. Steps 3 to 5 are what make the tool safe, so never skip them.

1. **Name and shape.** `snake_case` verb plus noun (`list_open_items`). Decide: does it only read, or does it change data?
2. **Domain first.** Put queries in `src/domain/<area>.ts` as plain functions taking `Db`. No MCP imports there.
   Parameterised SQL only.
3. **Create `src/mcp/tools/<name>.ts`** exporting `register<Name>(server, ctx)`:
   - `inputSchema`: Zod fields with `.describe()` on each, plus sensible `.min()` / `.max()`.
   - `outputSchema`: always include `status` and `message`; other fields optional.
   - `annotations`: read tools `{ readOnlyHint: true, openWorldHint: false }`; write tools
     `{ readOnlyHint: false, destructiveHint: <true if it overwrites or removes>, idempotentHint: <…> }`.
   - Description: say what it returns and what Claude should do in edge cases (ask, don't guess).
4. **Handler body inside `runTool(ctx, '<name>', input, async () => …)`.** It writes the audit row.
5. **Access before data.** Resolve client ids, then `canAccessClient` / `partitionByAccess`. On refusal return
   `outcome: 'denied'` and a message with no client data. Write tools re-check access even if the client came from
   an earlier tool call.
6. **Register** it in `src/mcp/server.ts`.
7. **Tests** in `test/<name>.test.ts` using `demoDb()` and `connectAs()`:
   allowed (partner), allowed (assigned assistant), denied (unassigned assistant, plus the audit row),
   not found or ambiguous, and the annotations from `listTools()`.
8. **Docs:** add a row to the tools table in `README.md`.
9. Run `npm run check`. Done only when it passes.
