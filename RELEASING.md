# Releasing

Packages here are versioned independently by Changesets, and **main is the
release branch**: `.github/workflows/release.yml` runs on every push to `main`
(and on `workflow_dispatch`). There is no `release:` or tag trigger and no
root version number; never create a tag or a GitHub Release by hand to cause
a publish.

## Flow

1. **Add a changeset in the PR that changes a package.** Author one per
   user-visible change:

       npx changeset

   Tooling-only PRs (CI, docs, scripts) need no changeset.

2. **Merge the PR.** The push to `main` runs `changesets/action`, which opens
   or updates the **"chore: version packages"** PR (branch
   `changeset-release/main`): it consumes the pending changesets, bumps
   versions and internal ranges, and writes the changelogs. Review the result.
   In particular, if a package jumps a whole major, stop: that usually means
   `.changeset/config.json` lost
   `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange`,
   which keeps changesets from majoring a peer *dependent* when a peer takes
   an in-range minor bump.

3. **Merge the Version Packages PR.** That push to `main` finds no pending
   changesets and runs `./scripts/staggered-publish.sh`, which publishes every
   package whose version is not on npm yet (with provenance), in dependency
   order. Already-published versions are skipped, so re-running is safe.

4. **Tags and Releases are by-products.** For each package it publishes, the
   script prints a `New tag:  <name>@<version>` line and creates the local tag;
   `changesets/action` (`createGithubReleases: true`) pushes the tags and
   creates one GitHub Release per package, for example
   `@johnhenry/browsermesh-pod@0.1.0`. A package that was skipped or failed
   emits no tag line. Older `v<version>` tags predate this and are historical.

5. **Verify against the registry, not against the tree:**

       npm view @johnhenry/browsermesh-<pkg> version

   `npm view` lags a successful publish by a minute or two. If the workflow
   log says `+ @johnhenry/...@x.y.z  Published successfully`, believe the log
   and re-check rather than reporting a failure.

   Where a release fixes something rather than bumping a number, confirm the
   published artifact carries it: unpack and grep, do not trust the version
   string. Two releases in this ecosystem shipped a version whose code
   differed from the tree.

## One-time repository requirements

The release job opens the Version Packages PR with `GITHUB_TOKEN`, which needs
**both**:

- `permissions: pull-requests: write` on the job (set in `release.yml`), and
- the repository setting *Settings > Actions > General > Workflow permissions >
  "Allow GitHub Actions to create and approve pull requests"*:

      gh api repos/johnhenry/browsermesh/actions/permissions/workflow
      gh api -X PUT repos/johnhenry/browsermesh/actions/permissions/workflow \
        -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true

Without the setting the action fails at `creating pull request` with "GitHub
Actions is not permitted to create or approve pull requests" (it still pushes
`changeset-release/main`, so the PR can be opened by hand from that branch as a
fallback).

The release job runs `npm test` before the version/publish step, so a flaky
test blocks a release; re-run the workflow (`gh workflow run release.yml`).
