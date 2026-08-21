# ADR-0002: Use GitHub and a PR-only workflow

- Status: accepted
- Date: 2026-08-21
- Decision owner: 于闯
- Related issue: YUC-4
- Supersedes: ADR-0001

## Context

The initial repository was created locally because no authenticated remote was available. The project now has an authorized GitHub repository at `yuchuang12/business`, so the local-only review boundary is no longer sufficient.

## Decision

- GitHub is the durable source repository for the project.
- `main` is the protected default branch; feature work is performed on issue-scoped branches.
- Changes reach `main` only through pull requests.
- While the repository has only one GitHub identity, branch protection requires
  zero approving reviews because GitHub does not count an author's self-review.
  Every pull request must still receive a recorded technical sign-off from the
  project coordinator before merge. Restore at least one required approving
  review when a distinct reviewer or bot identity becomes available.
- Review conversations must be resolved before merge.
- Force pushes and branch deletion are prohibited on `main`.
- Pull-request titles or branch names include the Multica issue key so repository work remains traceable.
- Public contract changes require an ADR and approval from the Architect or affected module reviewer before merge.

## Alternatives considered

- Continue with local commits only: rejected because it does not provide a durable remote review and collaboration boundary.
- Permit direct pushes to `main`: rejected because it bypasses the required review gate and weakens contract governance.
- Keep one required approving review with the current single identity: rejected
  because it permanently blocks every pull request; the author cannot approve
  their own change on GitHub.
- Introduce multiple long-lived integration branches: rejected as unnecessary for the MVP.

## Consequences

- Every code or documentation change has a reviewable diff and an issue-linked history.
- Until a distinct reviewer identity exists, the coordinator's recorded
  technical sign-off is the review gate even though GitHub's numeric approval
  requirement is zero.
- Emergency changes still require a pull request; repository administrators retain recovery authority but should not use it for routine delivery.
- Automation and agents must create issue-scoped branches and may not push directly to `main`.

## Compatibility and migration

The local baseline is replayed on top of the existing GitHub default branch and delivered by pull request. Existing repository content is preserved. Future task checkouts use the GitHub project resource; the local-directory resource remains a development convenience rather than the source of truth.
