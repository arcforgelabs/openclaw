# Arc Forge rehearsal fork

`arcforgelabs/openclaw` holds all Arc Forge work on OpenClaw: issues, evidence,
feature branches, and the rehearsal of each pull request before it goes to
`openclaw/openclaw`. Our own ClawSweeper
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

The upstream pull request opens from the personal publish fork
`IAMSamuelRodda/openclaw`, because GitHub allows "Allow edits by maintainers"
only on a fork that a person owns. Push the same commits there only when the
upstream pull request opens:

```bash
git push personal feat/my-change
gh pr create -R openclaw/openclaw --base main \
  --head IAMSamuelRodda:feat/my-change
git ls-remote fork feat/my-change; git ls-remote personal feat/my-change   # same commit
gh pr view <number> -R openclaw/openclaw --json maintainerCanModify          # true
```

If a maintainer pushes a commit, fetch it from the personal fork into this
fork's branch before your next push.

Close the rehearsal pull request after the upstream one is open.

## Keep the fork current

Run `.arcforge/sync.sh` from any clone; a blobless clone is enough. Add `--dry-run` to see what it would do.
It fast-forwards `main` to upstream, rebases the infrastructure commit onto it,
and disables any new upstream workflow. Do not use GitHub's "Sync fork" button:
a new upstream workflow would arrive enabled.

Open rehearsal pull requests keep working after a sync. To review against the
newer upstream, rebase the feature branch onto `upstream/main` and push it.

## Issues

Record each fault we find, each fix we carry, and each port plan as an issue
here, with one tracking issue per area (for example #7 for the Linux app). The
personal publish fork has issues turned off. This fork is public, so keep
private evidence out of it. The order from a fault to an upstream pull request
is in #5: record, verify on a fresh install, search upstream, decide, build on
an approved branch, rehearse, then publish. Send upstream pull requests in waves
of two or three, one issue each.
