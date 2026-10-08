#!/usr/bin/env bash
# Vendor D3 into assets/. Run from the repository root.
# The script downloads the pinned upstream files to a temp dir, checks the
# sha384 of d3.min.js, and moves the files into assets/.
# Keep VERSION and PIN in sync with src/assets.rs and assets/manifest.json.
# Needs curl, openssl, and coreutils (base64 -w0).
set -euo pipefail

VERSION="7.9.0"
PIN="CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i"
BASE="https://cdn.jsdelivr.net/npm/d3@${VERSION}"
OUT="assets"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

curl -fsSL "${BASE}/dist/d3.min.js" -o "${TMP}/d3.min.js"
curl -fsSL "${BASE}/LICENSE" -o "${TMP}/D3-LICENSE"
actual="$(openssl dgst -sha384 -binary "${TMP}/d3.min.js" | base64 -w0)"
if [[ "${actual}" != "${PIN}" ]]; then
  echo "sha384 mismatch: d3.min.js (${actual})" >&2
  exit 1
fi
mv "${TMP}/d3.min.js" "${OUT}/d3.min.js"
mv "${TMP}/D3-LICENSE" "${OUT}/D3-LICENSE"
echo "vendored d3@${VERSION}"
