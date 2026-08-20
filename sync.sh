#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

rsync -av --exclude '.git' --exclude-from='.gitignore' ./ pi-logger:~/weather/
