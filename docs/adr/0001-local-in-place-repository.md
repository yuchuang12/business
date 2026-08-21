# ADR-0001: Use a local in-place repository for the initial MVP

- Status: superseded by ADR-0002
- Date: 2026-08-21
- Decision owner: 于闯
- Related issues: YUC-3, YUC-4

## Context

The Multica project initially had no GitHub or local-directory resource, which blocked contract authoring. The project owner explicitly directed the team to write locally under `~/bussinesscode` and create a new folder.

The available daemon does not advertise the `local-worktree-v1` capability, so Multica cannot safely use isolated git worktrees for concurrent tasks on this directory.

## Decision

- Create the repository at `~/bussinesscode/agent-commerce-platform`.
- Attach it to the Multica project as a `local_directory` resource using `in_place` execution.
- Use git commits as the local review boundary.
- Run one repository-writing task at a time until worktree capability or a remote Git provider is added.
- Keep public contracts frozen and reviewed through their dedicated Multica issues before implementation fan-out.

## Alternatives considered

- GitHub repository: rejected for now because the owner requested direct local development and supplied no remote URL.
- Local `worktree` execution: unavailable because the current daemon does not advertise the required capability.
- Unversioned directory: rejected because contract and ADR history must remain auditable.

## Consequences

- The initial setup and contract work can proceed immediately.
- Concurrent code-writing tasks must not target the same local resource; Multica will serialize them in `in_place` mode.
- Branch protection and GitHub PR automation are unavailable until a remote is attached.
- When a remote or worktree-capable daemon is introduced, this ADR must be superseded with the migration and review workflow.

## Compatibility and migration

The repository layout and git history are portable. ADR-0002 records the completed migration to GitHub and the replacement PR-only workflow.
