#!/bin/bash
# PostToolUse hook (Write|Edit): formats the file Claude just wrote with the
# owning dashboard package's oxfmt (`npm run format`), so each package's own
# .oxfmtrc.json applies. Files outside dashboard/client and dashboard/server,
# and file types oxfmt doesn't handle, are left alone.
#
# Exit 2 sends oxfmt's error back to Claude — a file that won't format
# usually doesn't parse.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0

case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.css | *.json) ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/*) exit 0 ;;
esac

dashboard="${CLAUDE_PROJECT_DIR:-$PWD}/dashboard"
for pkg in client server; do
  case "$file" in
    "$dashboard/$pkg/"*)
      if ! output=$(cd "$dashboard/$pkg" && npm run --silent format -- "$file" 2>&1); then
        echo "oxfmt failed on $file:" >&2
        echo "$output" >&2
        exit 2
      fi
      exit 0
      ;;
  esac
done
exit 0
