#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# The plists in this directory are templates, so no machine-specific paths
# get committed. This fills them in for the current machine, installs them
# as launchd agents, and (re)starts them. Safe to re-run, e.g. after
# switching node versions with nvm.

REPO_DIR="$(cd .. && pwd)"
LOG_DIR="$HOME/Library/Logs/WeatherLogger"
AGENTS_DIR="$HOME/Library/LaunchAgents"
NODE="$(command -v node)"
DOMAIN="gui/$(id -u)"

mkdir -p "$LOG_DIR" "$AGENTS_DIR"

for template in com.weatherlogger.*.plist; do
  label="${template%.plist}"
  target="$AGENTS_DIR/$template"
  sed -e "s#__REPO_DIR__#$REPO_DIR#g" \
    -e "s#__LOG_DIR__#$LOG_DIR#g" \
    -e "s#__NODE__#$NODE#g" \
    "$template" >"$target"
  plutil -lint -s "$target"
  # bootout fails if the agent isn't loaded yet, which is fine on first install.
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$target"
  echo "Installed $label"
done
