---
name: security-review
description: Review ClientDesk changes for access-control, audit and data-handling mistakes. Use before committing anything that touches tools, SQL, auth or logging, or when asked to review a diff.
---

# Security review

Run `git diff` (and `git diff --staged`), then check each item. Report findings as `file:line: problem → fix`.
If everything passes, say so in one line.

## Access and identity

- [ ] Every tool handler runs inside `runTool()`.
- [ ] Client data is read only after `canAccessClient` / `partitionByAccess` for **this** actor.
- [ ] Denied responses contain no client data: names only when the user already typed them, no contacts, notes or documents.
- [ ] Write tools re-check access themselves and don't trust ids from earlier tool output.
- [ ] Identity comes only from `resolveActor()` (`src/http.ts`), never from tool arguments.

## Data handling

- [ ] SQL is parameterised; no string-built SQL from inputs.
- [ ] New sensitive fields are covered by `maskSensitive` (`src/domain/audit.ts`).
- [ ] Nothing logs request bodies, tokens or document text to the console.
- [ ] Errors returned to the model are generic; details go to the audit log only.

## Claude-facing behaviour

- [ ] Annotations match reality (`readOnlyHint`, `destructiveHint`).
- [ ] Ambiguous matches return candidates instead of picking one.
- [ ] Tool descriptions don't promise anything the code doesn't enforce.

## Tests

- [ ] There is a denied-path test with an audit assertion for each new or changed tool.
