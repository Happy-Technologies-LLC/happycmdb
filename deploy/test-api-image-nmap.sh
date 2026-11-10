#!/usr/bin/env bash
# HAP-1755: the api image must be able to exec nmap as its normal user without any added capability.
# Run by the `api-image-nmap` job in .github/workflows/test.yml, and by operators where Docker exists (Build01).
# Usage: deploy/test-api-image-nmap.sh <api-image>
# Failure guarded: nmap carrying a file capability (setcap +eip cap_net_admin,cap_net_raw) that is missing from the
# container's bounding set makes the kernel refuse the exec ("Operation not permitted"). Docker's default set has NET_RAW
# but no NET_ADMIN (the real failure); --cap-drop ALL removes both. Through the dumb-init ENTRYPOINT the refusal shows as
# rc 2 ("[dumb-init] nmap: Operation not permitted"); only a direct `--entrypoint nmap` gives rc 255.
set -euo pipefail

image=${1:?usage: $0 <api-image>}
scan() { docker run --rm --network none --user nodejs "$@" "$image" nmap -sT -p 22 127.0.0.1; }

echo "nmap -sT as nodejs, default capabilities"; scan
echo "nmap -sT as nodejs, --cap-drop ALL"; scan --cap-drop ALL
