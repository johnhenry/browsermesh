# Releasing

Packages here are versioned independently by changesets, so no single package
version can name a release. The **private root `package.json` version is the
release marker**, and the tag is `v<that version>` — the same scheme raijin
uses, and consistent with wsh's `v<version>` tags.

A date-stamped tag (`release-2026-09-08`) was used once, before this was
written down. It is the odd one out across the three repos; use `v<version>`.

## Steps

1. Land the work. Author a changeset per user-visible change:

       npx changeset

2. Version the packages and write their changelogs:

       npx changeset version

   Check the result before committing. In particular, if a package jumps a
   whole major, stop: that usually means `.changeset/config.json` lost
   `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange`,
   which keeps changesets from majoring a peer *dependent* when a peer takes
   an in-range minor bump.

3. Bump the root `version` by one patch. It names the release, nothing else —
   it is private and never published.

4. Merge, then cut a GitHub Release tagged `v<root version>` against `main`.

   Publishing is triggered by `release: published`, **not** by pushing a tag.
   A bare `git tag` publishes nothing here (wsh works the other way round —
   its workflow fires on `push: tags: v*`). `workflow_dispatch` also works.

5. Verify against the registry, not against the tree:

       npm view @johnhenry/browsermesh-<pkg> version

   `npm view` lags a successful publish by a minute or two. If the workflow
   log says `+ @johnhenry/...@x.y.z  Published successfully`, believe the log
   and re-check rather than reporting a failure.

   Where a release fixes something rather than bumping a number, confirm the
   published artifact carries it — unpack and grep, do not trust the version
   string. Two releases in this ecosystem shipped a version whose code
   differed from the tree.

`scripts/staggered-publish.sh` skips any package already at its published
version, so re-running a release is safe and unchanged packages are simply
reported as skipped.
