#!/usr/bin/env bash
# HAP-1754: the non-root `nodejs` user of every service image is uid 1001, primary group `nodejs` (gid 1001), and in no other group.
# Dockerfile.api, .api.dev, .discovery, .etl and .agent create it with `adduser -S -G nodejs -u 1001 nodejs`;
# without -G the user does not join the `nodejs` group created one line earlier.
# Run by the `api-image-nmap` job in .github/workflows/test.yml, and by operators where Docker exists.
# Usage: deploy/test-image-user.sh <image>
set -euo pipefail

image=${1:?usage: $0 <image>}
# busybox `id` repeats the primary group in groups=; compare the distinct group list.
got=$(docker run --rm --entrypoint sh "$image" -c 'printf "%s %s %s" "$(id -u nodejs)" "$(id -g nodejs)" "$(id -Gn nodejs | tr " " "\n" | sort -u | tr "\n" "," )"')
echo "$image: uid gid groups = $got"
[ "$got" = "1001 1001 nodejs," ] || { echo "FAIL: expected uid 1001, gid 1001, only group nodejs" >&2; exit 1; }
