#!/bin/bash
# Stop hook: type-checks and lints the dashboard at the end of every turn,
# and blocks the turn from ending while anything fails — lint runs with
# --deny-warnings, so a warning fails it just like an error.
#
#   client: npm run typecheck (tsc -b), npm run lint (oxlint --deny-warnings)
#   server: npm run typecheck (tsc, tests included), npm run lint (oxlint --deny-warnings)
#
# Exit 2 sends the failures back to Claude to fix. If the turn is already
# continuing because of this hook (stop_hook_active), it's allowed to end
# instead of looping forever, and the failures are shown to the user.
set -uo pipefail

input=$(cat)
dashboard="${CLAUDE_PROJECT_DIR:-$PWD}/dashboard"
failures=""

run() {
  local pkg=$1 script=$2 output
  if ! output=$(cd "$dashboard/$pkg" && npm run --silent "$script" 2>&1); then
    failures+=$'\n'"== dashboard/$pkg: npm run $script =="$'\n'"$output"$'\n'
  fi
}

run client typecheck
run client lint
run server typecheck
run server lint

[ -z "$failures" ] && exit 0

if [ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ]; then
  jq -n --arg msg "Type-check/lint still failing after a fix attempt:$failures" '{systemMessage: $msg}'
  exit 0
fi

echo "Type-check/lint failed — fix these before finishing:$failures" >&2
exit 2
