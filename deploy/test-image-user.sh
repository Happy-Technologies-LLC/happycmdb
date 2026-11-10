#!/usr/bin/env bash
# HAP-1754: the non-root `nodejs` user of every service image is uid 1001 with primary group `nodejs` (gid 1001).
# Dockerfile.api, .api.dev, .discovery, .etl and .agent create it with `adduser -S -G nodejs -u 1001 nodejs`;
# without -G the user does not join the `nodejs` group created one line earlier.
# Run by the `api-image-nmap` job in .github/workflows/test.yml, and by operators where Docker exists.
# Usage: deploy/test-image-user.sh <image>
set -euo pipefail

image=${1:?usage: $0 <image>}
got=$(docker run --rm --entrypoint id "$image" nodejs)
echo "$image: $got"
[ "$got" = "uid=1001(nodejs) gid=1001(nodejs) groups=1001(nodejs)" ] || { echo "FAIL: unexpected nodejs identity" >&2; exit 1; }
