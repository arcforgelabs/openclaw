#!/usr/bin/env bash
# Sync the Arc Forge rehearsal fork with upstream OpenClaw.
#
#   fork main           := upstream main (fast-forward only; never our commits)
#   master (rehearsal)  := upstream main + the Arc Forge infrastructure commit
#
# It also disables every workflow in the fork that is not ours and cancels any
# run such a workflow started, before and after the push. A new upstream
# workflow arrives enabled, so never update the fork any other way (not with
# GitHub's "Sync fork" button either).
#
# Usage: .arcforge/sync.sh [--dry-run]
# Run it from any clone of openclaw, a blobless one is enough
# (git clone --filter=blob:none). It does not touch your checkout.
# Needs git 2.40 or later (merge-tree --write-tree), gh (admin on the fork) and jq.
set -euo pipefail

FORK=arcforgelabs/openclaw
UPSTREAM=openclaw/openclaw
BRANCH=master
OURS='^(\.arcforge/|\.github/workflows/arcforge-)'
# Git URLs can point elsewhere for a local rehearsal of this script.
FORK_URL=${FORK_URL:-https://github.com/$FORK.git}
UPSTREAM_URL=${UPSTREAM_URL:-https://github.com/$UPSTREAM.git}
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

die() { printf 'sync: %s\n' "$*" >&2; exit 1; }
log() { printf 'sync: %s\n' "$*" >&2; }
run() { if (( DRY_RUN )); then log "dry run, skipped: $*"; else "$@"; fi; }

git rev-parse --git-dir >/dev/null 2>&1 || die "run inside a clone of $UPSTREAM"

guard_workflows() {
  local id path
  gh api "repos/$FORK/actions/workflows?per_page=100" --jq '.workflows[]
      | select(.state == "active" and (.path | startswith(".github/workflows/")))
      | select(.path | test("^\\.github/workflows/arcforge-") | not)
      | "\(.id) \(.path)"' |
    while read -r id path; do
      log "disabling $path"
      run gh api -X PUT "repos/$FORK/actions/workflows/$id/disable" >/dev/null
    done
  for status in queued in_progress; do
    gh api "repos/$FORK/actions/runs?status=$status&per_page=100" --jq '.workflow_runs[]
        | select(.path | startswith(".github/workflows/"))
        | select(.path | test("^\\.github/workflows/arcforge-") | not)
        | "\(.id) \(.path)"' |
      while read -r id path; do
        log "cancelling run $id ($path)"
        run gh api -X POST "repos/$FORK/actions/runs/$id/cancel" >/dev/null || true
      done
  done
}

git fetch -q "$UPSTREAM_URL" "+refs/heads/main:refs/arcforge-sync/upstream-main"
git fetch -q "$FORK_URL" \
  "+refs/heads/main:refs/arcforge-sync/fork-main" \
  "+refs/heads/$BRANCH:refs/arcforge-sync/rehearsal"
up=$(git rev-parse refs/arcforge-sync/upstream-main)
fork_main=$(git rev-parse refs/arcforge-sync/fork-main)
old=$(git rev-parse refs/arcforge-sync/rehearsal)

git merge-base --is-ancestor "$fork_main" "$up" ||
  die "fork main has commits that upstream lacks; it must stay a mirror (git log $up..$fork_main)"

base=$(git merge-base "$old" "$up")
outside=$(git diff --name-only "$base" "$old" | grep -Ev "$OURS" || true)
[[ -z "$outside" ]] || die "$BRANCH changes files outside the Arc Forge paths: $outside"
[[ "$(git rev-list --count "$base..$old")" == 1 ]] ||
  die "$BRANCH must be upstream main plus exactly one infrastructure commit"

if [[ "$base" == "$up" ]]; then
  new=$old
  log "$BRANCH already sits on upstream main ${up:0:12}"
else
  # Rebase without a checkout: merge our one commit's change onto upstream.
  tree=$(git merge-tree --write-tree --merge-base "$base" "$old" "$up" | head -n1) ||
    die "the infrastructure commit conflicts with upstream; resolve it in a clone by hand"
  new=$(git log -1 --format=%B "$old" | GIT_AUTHOR_NAME="$(git log -1 --format=%an "$old")" \
    GIT_AUTHOR_EMAIL="$(git log -1 --format=%ae "$old")" git commit-tree "$tree" -p "$up")
  log "rebased the infrastructure commit onto upstream ${up:0:12}"
fi

outside=$(git diff --name-only "$up" "$new" | grep -Ev "$OURS" || true)
[[ -z "$outside" ]] || die "rebased $BRANCH changes files outside the Arc Forge paths: $outside"

guard_workflows
if [[ "$fork_main" != "$up" ]]; then
  log "fast-forwarding fork main ${fork_main:0:12} -> ${up:0:12}"
  run git push -q "$FORK_URL" "$up:refs/heads/main"
fi
if [[ "$new" != "$old" ]]; then
  log "updating $BRANCH ${old:0:12} -> ${new:0:12}"
  run git push -q --force-with-lease="refs/heads/$BRANCH:$old" \
    "$FORK_URL" "$new:refs/heads/$BRANCH"
fi
# GitHub registers a new workflow file a few seconds after the push.
(( DRY_RUN )) || sleep 20
guard_workflows
log "done: main=${up:0:12} $BRANCH=${new:0:12}"
