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
