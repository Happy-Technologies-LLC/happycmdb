#!/usr/bin/env bash
# HAP-1818: behavioral check of the /api/v1/auth/ rate limits in infrastructure/docker/nginx.conf.
#
# Runs the config in Docker exactly as deployed (a conf.d include in the stock nginx image) in front of a stub
# api-server that answers 200 to every request, then asserts:
#   1. refresh and me, alternated 6 times in a row, are never refused (a page load, a reload, a second tab);
#   2. login is 429 once its burst is spent, and password plus the spellings Express also routes to login
#      (trailing slash, other letter case) are refused from the same bucket; login is still refused 1.5 s and
#      9 s later (no refill yet at 5r/m; 5r/s would admit at 1.5 s, 10r/m or looser at 9 s) and admitted 14 s
#      later (the bucket refills at about 5r/m);
#   3. refresh and me still answer once the login bucket is spent;
#   4. the session zone still refuses a flood;
#   5. (HAP-1844) a client cannot pick its own auth_limit bucket: 4 logins, each with a different X-Forwarded-For,
#      still get 429 on the 4th, because the config as shipped keeps set_real_ip_from commented out. Run against a
#      second, fresh nginx so it does not spend the login bucket that section 2 measures. With
#      `set_real_ip_from 0.0.0.0/0; real_ip_header X-Forwarded-For;` enabled each request lands in its own bucket
#      and this section fails.
#
# Usage: test-nginx-auth-limits.sh [path/to/nginx.conf]   (default: the nginx.conf next to this script)
# Needs docker, curl and openssl. NGINX_IMAGE overrides the image (default: the Dockerfile.web tag).
# Exit status: 0 every assertion passed, 1 an assertion failed, 2 setup failed.
set -euo pipefail

conf=$(realpath "${1:-$(dirname "$0")/nginx.conf}")
image=${NGINX_IMAGE:-nginx:1.25-alpine}
run_id="hap1818-$$-$RANDOM"
net="$run_id-net"
stub="$run_id-stub"
proxy="$run_id-proxy"
proxy2="$run_id-proxy2"
work=$(mktemp -d)

cleanup() {
  docker rm -f "$stub" "$proxy" "$proxy2" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

setup_failed() {
  echo "SETUP FAILED: $*" >&2
  docker logs "$proxy" >&2 2>&1 || true
  exit 2
}

[ -f "$conf" ] || setup_failed "no config at $conf"

# Throwaway TLS material at the paths nginx.conf names (never committed).
mkdir -p "$work/ssl"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=nginx-auth-limits.invalid' \
  -keyout "$work/ssl/key.pem" -out "$work/ssl/cert.pem" 2>/dev/null || setup_failed "openssl req"
cp "$work/ssl/cert.pem" "$work/ssl/chain.pem"
openssl dhparam -dsaparam -out "$work/ssl/dhparam.pem" 2048 2>/dev/null || setup_failed "openssl dhparam"
chmod -R a+rX "$work"

# Stub upstream: nginx.conf proxies to api-server:3000.
cat >"$work/stub.conf" <<'EOF'
server {
    listen 3000;
    location / {
        default_type text/plain;
        return 200 "stub $request_method $uri\n";
    }
}
EOF

docker network create "$net" >/dev/null || setup_failed "docker network create"
docker run -d --name "$stub" --network "$net" --network-alias api-server \
  -v "$work/stub.conf:/etc/nginx/conf.d/default.conf:ro" "$image" >/dev/null || setup_failed "start stub"
start_proxy() { # $1 container name; sets $port to its published https port
  local name=$1
  docker run -d --name "$name" --network "$net" -p 127.0.0.1::443 \
    -v "$work/ssl:/etc/nginx/ssl:ro" \
    -v "$conf:/etc/nginx/conf.d/default.conf:ro" "$image" >/dev/null || setup_failed "start nginx $name"
  port=""
  for _ in $(seq 1 60); do
    port=$(docker port "$name" 443/tcp 2>/dev/null | sed -n 's/^127\.0\.0\.1://p' | head -n 1) || true
    # /health is a plain `return 200` with no limit_req, so polling it spends no rate-limit budget.
    if [ -n "$port" ] && [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 "https://127.0.0.1:$port/health")" = 200 ]; then
      break
    fi
    [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] || { docker logs "$name" >&2 2>&1 || true; setup_failed "nginx $name exited"; }
    port=""
    sleep 0.5
  done
  [ -n "$port" ] || { docker logs "$name" >&2 2>&1 || true; setup_failed "nginx $name did not answer /health"; }
}

start_proxy "$proxy"
port1=$port
start_proxy "$proxy2"
port2=$port
port=$port1

status() { # $1 method, $2 path, rest: extra curl args; prints 000 when the request itself fails
  local method=$1 path=$2
  shift 2
  curl -sk -o /dev/null -w '%{http_code}' --max-time 5 -X "$method" "$@" "https://127.0.0.1:$port$path" || true
}

failures=0
expect() { # $1 label, $2 method, $3 path, $4 wanted status, rest: extra curl args
  local got
  got=$(status "$2" "$3" "${@:5}")
  if [ "$got" = "$4" ]; then
    echo "ok: $1 ($2 $3): $got"
  else
    echo "FAIL: $1 ($2 $3): got $got, want $4"
    failures=$((failures + 1))
  fi
}

echo "== 1. session endpoints, alternated 6 times"
for i in 1 2 3 4 5 6; do
  if [ $((i % 2)) = 1 ]; then
    expect "session request $i" POST /api/v1/auth/refresh 200
  else
    expect "session request $i" GET /api/v1/auth/me 200
  fi
done

echo "== 2. login burst, then the same bucket for every credential spelling"
for i in 1 2 3; do
  expect "login request $i" POST /api/v1/auth/login 200
done
expect "login request 4 (burst spent)" POST /api/v1/auth/login 429
expect "password change, login bucket spent" PUT /api/v1/auth/password 429
expect "login with trailing slash" POST /api/v1/auth/login/ 429
expect "login in other letter case" POST /api/v1/AUTH/Login 429
# The bucket refills at the zone rate from the last admitted login (refusals spend nothing), so the elapsed time
# since the third admit separates rates. Probe 1 (~1.5 s) catches a per-second rate (5r/s refills 7 requests).
# Probe 2 (~9 s) must still be refused: one refill takes 12 s at 5r/m, 6 s at 10r/m and 2 s at 30r/m, so any rate
# of 10r/m or looser admits it. Probe 3 (~14 s) must be admitted: it proves the bucket refills at all (a zone
# tightened to, say, 1r/m would pass probes 1 and 2) and bounds the rate from below at about 5r/m.
sleep 1.5
expect "login 1.5 s after the burst (no refill at 5r/m)" POST /api/v1/auth/login 429
sleep 7.5
expect "login 9 s after the burst (one refill needs 12 s at 5r/m; 10r/m would admit it)" POST /api/v1/auth/login 429
sleep 5
expect "login 14 s after the burst (one refill has accrued at 5r/m)" POST /api/v1/auth/login 200

echo "== 3. session endpoints after the login bucket is spent"
expect "refresh after login refusals" POST /api/v1/auth/refresh 200
expect "me after login refusals" GET /api/v1/auth/me 200

echo "== 4. the session zone still refuses a flood"
refused=0
for _ in $(seq 1 40); do
  if [ "$(status POST /api/v1/auth/refresh)" = 429 ]; then refused=$((refused + 1)); fi
done
if [ "$refused" -gt 0 ]; then
  echo "ok: 40 back-to-back refreshes, $refused refused with 429"
else
  echo "FAIL: 40 back-to-back refreshes, none refused (session zone not applied)"
  failures=$((failures + 1))
fi

echo "== 5. a client cannot choose its auth_limit bucket with X-Forwarded-For (fresh nginx, untouched login bucket)"
port=$port2
for i in 1 2 3; do
  expect "login with forged X-Forwarded-For $i" POST /api/v1/auth/login 200 -H "X-Forwarded-For: 198.51.100.$i"
done
expect "login 4 with a fourth forged X-Forwarded-For (same bucket, burst spent)" POST /api/v1/auth/login 429 -H "X-Forwarded-For: 198.51.100.4"

if [ "$failures" -gt 0 ]; then
  echo "$failures assertion(s) failed against $conf"
  exit 1
fi
echo "all assertions passed against $conf"
