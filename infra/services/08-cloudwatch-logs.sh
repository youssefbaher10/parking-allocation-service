#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

for group in /aws/ecs/parking-allocation /aws/lambda/parking-allocation-sweep; do
  allow_duplicate 'ResourceAlreadyExists' awsl logs create-log-group --log-group-name "$group"
done
allow_duplicate 'ResourceAlreadyExists' awsl logs create-log-stream --log-group-name /aws/ecs/parking-allocation --log-stream-name local-workers
echo "Log groups and local worker stream configured. Runtime delivery must be tested."
