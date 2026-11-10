#!/usr/bin/env bash
# HAP-1754: the web-ui image (infrastructure/docker/Dockerfile.web) must still start and serve the built bundle.
# Run by the `web-ui-build` job in .github/workflows/test.yml, and by operators where Docker exists.
# Usage: deploy/test-web-image-start.sh <web-ui-image>
# nginx resolves the `api-server` upstream at start-up, so the container gets a throwaway host alias for it.
# Only the static bundle and /health are exercised; nothing proxies to an api.
set -euo pipefail

image=${1:?usage: $0 <web-ui-image>}
port=18080

cid=$(docker run -d --add-host api-server:127.0.0.1 -p "127.0.0.1:$port:80" "$image")
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT

up=no
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" = 200 ]; then up=yes; break; fi
  [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = true ] || break
  sleep 1
done
[ "$up" = yes ] || { docker logs "$cid" >&2; echo "FAIL: /health never answered 200" >&2; exit 1; }

index=$(curl -fsS "http://127.0.0.1:$port/")
grep -q '<div id="root"' <<<"$index" || { echo "FAIL: / is not the built index.html" >&2; exit 1; }
asset=$(grep -oE 'src="/assets/[^"]+\.js"' <<<"$index" | head -1 | sed 's/^src="//;s/"$//')
[ -n "$asset" ] || { echo "FAIL: index.html references no built /assets/*.js" >&2; exit 1; }
curl -fsS -o /dev/null "http://127.0.0.1:$port$asset"
echo "OK: /health 200, / serves the bundle, $asset served"
