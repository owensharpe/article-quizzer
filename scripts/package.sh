#!/usr/bin/env bash
# Zips the extension folder for upload to the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
out="dist/article-quizzer-$version.zip"
mkdir -p dist
rm -f "$out"
(cd extension && zip -qr "../$out" . -x '.*' -x '*/.*')
echo "$out"
