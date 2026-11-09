#!/usr/bin/env bash
# HAP-1755: the api image must be able to exec nmap as its normal user without any added capability.
# Operator-run where Docker exists (Build01). NOT part of CI: no workflow builds Dockerfile.api.
# Usage: deploy/test-api-image-nmap.sh <api-image>
# rc 126 "Operation not permitted" = exec refused: nmap carries a file capability (setcap +eip) that is missing from the
# container's bounding set (cap_net_admin is not in Docker's default set; NET_RAW is gone under --cap-drop ALL).
set -euo pipefail

image=${1:?usage: $0 <api-image>}
scan() { docker run --rm --network none --user nodejs "$@" "$image" nmap -sT -p 22 127.0.0.1; }

echo "nmap -sT as nodejs, default capabilities"; scan
echo "nmap -sT as nodejs, --cap-drop ALL"; scan --cap-drop ALL
