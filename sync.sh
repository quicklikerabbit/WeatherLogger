#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

rsync -av --exclude '.git' --exclude 'tests' --exclude-from='.gitignore' ./ pi-logger:~/weather/
