# Arc Forge rehearsal fork

`arcforgelabs/openclaw` is where Arc Forge rehearses a pull request before it
goes to `openclaw/openclaw`. Our own ClawSweeper
(`arc-forge-clawsweeper-review[bot]`) reviews each rehearsal pull request at its
exact head, and Barnacle, the labeler and the command reactions run on it. This
directory and the `arcforge-*` workflows are the only Arc Forge files here. They
never go upstream.

## Branches

| Branch | Content | Rule |
| --- | --- | --- |
| `main` | Exact mirror of upstream `main` | Never commit to it. |
| `master` (default, the rehearsal branch) | Upstream `main` plus one infrastructure commit | Change only `.arcforge/` and `.github/workflows/arcforge-*`. |
| Feature branches | Your change, cut from upstream `main` | Never cut from `master`. |

`master` is the default branch, so `pull_request_target` and issue
workflows read our files from it. Every upstream workflow is disabled in the
fork's Actions settings.

The rehearsal branch is called `master` because the Arc Forge ClawSweeper
publisher reviews only pull requests whose base is `main` or `master`. A
pull request against any other base gets no review. `main` must stay the
upstream mirror, so the rehearsal branch takes the other accepted name.

## Rehearse a pull request

The commands use `upstream` for `openclaw/openclaw` and `fork` for this repo.

```bash
git fetch upstream main
git switch -c feat/my-change upstream/main
# commit the change
git push fork feat/my-change
gh pr create -R arcforgelabs/openclaw \
  --base master --head feat/my-change
```

Write the body with the upstream template. The pull request diff shows only
your change, because the merge base is upstream `main`. Wait for the ClawSweeper
comment, fix the findings, and push again; each push gets a new review.

Before you post upstream, make sure that the branch holds no Arc Forge file:

```bash
git diff --name-only upstream/main...feat/my-change | grep -E '^(\.arcforge/|\.github/)' && echo STOP
```

This fork is also the head repository for the upstream pull request; Arc Forge
has no personal fork of OpenClaw. Open it from the same branch:

```bash
gh pr create -R openclaw/openclaw --base main \
  --head arcforgelabs:feat/my-change
```

GitHub does not allow "Allow edits by maintainers" on a fork that an
organisation owns, so say in the pull request body that maintainers can ask for
changes and we push them.

Close the rehearsal pull request after the upstream one is open.

## Keep the fork current

Run `.arcforge/sync.sh` from any clone; a blobless clone is enough. Add `--dry-run` to see what it would do.
It fast-forwards `main` to upstream, rebases the infrastructure commit onto it,
and disables any new upstream workflow. Do not use GitHub's "Sync fork" button:
a new upstream workflow would arrive enabled.

Open rehearsal pull requests keep working after a sync. To review against the
newer upstream, rebase the feature branch onto `upstream/main` and push it.

## Repository-owned bot policy

The two enabled arcforge-barnacle.yml and arcforge-labeler.yml workflows
are the only triage event owners. Upstream auto-response.yml and labeler.yml
remain unchanged and disabled. Do not enable them alongside the Arc Forge jobs.
The existing command-reactions workflow is independent and stays unchanged.

Both jobs mint a token scoped to this repository using org variable GH_APP_ID
(primary 5116230) and secret GH_APP_PRIVATE_KEY. Token creation failure selects
GH_APP_ID_FALLBACK (5711023) and GH_APP_PRIVATE_KEY_FALLBACK; failure of both
is a failed job, never an anonymous or GITHUB_TOKEN write. Only trusted base
code is checked out, with no persisted credentials.

Barnacle policy lives in barnacle/config.json, with the existing optional
.github/barnacle.json default-branch data override contract retained. The
configured upstream snapshot in vendor/openclaw/ is the exact implementation
previously served by central commit b0fc9bcc89b5219efc0c8e5f855aaedc3ccec6b6,
not a second enabled owner. Its upstream identity is in vendor/openclaw/UPSTREAM
and its license is retained. Keeping the snapshot avoids silently changing
rehearsal policy to the newer upstream product defaults. The PR cap remains
20, ClawSweeper branches and maintainers remain exempt, and the retired
Clownfish prefix has no exemption. Product-specific disabled rules remain inert.

The labeler preserves the previous central policy at
a115c8f8dc02978d8c82c9554f02ea8e013a6981, including the local upstream
.github/labeler.yml area map, size labels, maintainer safeguards and bounded
manual backfill. Its label-cap helper uses the existing local upstream owner
scripts/github/labeler-label-cap.mjs. No central workflow checkout is needed.

Run node --test .arcforge/test/*.test.mjs for focused policy proof. The
arcforge-bot-test.yml workflow runs that proof without secrets on PR code.
Source tests do not prove live App authentication or fallback failover. After
landing, use a bounded labeler dispatch and an authorized outside-item label
for live proof; do not restore retired credentials to test the old path.
