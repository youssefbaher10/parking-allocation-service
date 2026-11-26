#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/services/_lib.sh"
case "${1:-}" in
  single|vertical|horizontal)
    count=1; [[ "$1" == horizontal ]] && count="${2:-3}"
    [[ "$count" =~ ^[1-3]$ ]] || { echo 'Count must be 1, 2 or 3'; exit 1; }
    # Do not create a second set of workers if native ECS tasks actually run.
    RUNNING=$(awsl ecs describe-services --cluster parking-cluster --services parking-allocation --query 'services[0].runningCount' --output text 2>/dev/null || echo unknown)
    if [[ "$RUNNING" =~ ^[1-9][0-9]*$ && "${PARKING_ALLOW_RECORDED_RUNNING:-0}" != 1 ]]; then echo 'ECS reports running tasks. Inspect docker ps; use native routing if real tasks exist, or set PARKING_ALLOW_RECORDED_RUNNING=1 only after confirming this is a recorded count.'; exit 1; fi
    # Verify host ports before updating metadata; local manager also checks ownership.
    node infra/runtime/workers.cjs preflight "$count"
    awsl ecs update-service --cluster parking-cluster --service parking-allocation --desired-count "$count" >/dev/null || warn 'ECS desired count update failed; local experiment can still run, report discrepancy.'
    # Keep foreground supervisor running. It starts local workers and proxy.
    node infra/runtime/workers.cjs start "$count"
    ;;
  kill) node infra/runtime/workers.cjs control "kill:${2:-}" ;;
  stop) node infra/runtime/workers.cjs control stop ;;
  status) node infra/runtime/workers.cjs control status ;;
  *) echo 'Usage: bash infra/scale-test.sh {single|horizontal [1-3]|kill 2|status|stop}'; exit 1;;
esac
