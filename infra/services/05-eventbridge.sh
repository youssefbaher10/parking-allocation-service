#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# EventBridge Scheduler sends periodic sweep requests to SQS; it is not the EventBridge event bus.
ACCOUNT_ID=$(account)
Q=$(awsl sqs get-queue-url --queue-name parking-allocation-maintenance --query QueueUrl --output text)
ARN=$(awsl sqs get-queue-attributes --queue-url "$Q" --attribute-names QueueArn --query Attributes.QueueArn --output text)
TARGET=$(node -e 'console.log(JSON.stringify({Arn:process.argv[1],RoleArn:process.argv[2],Input:JSON.stringify({type:"allocation_sweep"})}))' "$ARN" "arn:aws:iam::$ACCOUNT_ID:role/parking-allocation-scheduler")
# Disabled by default until manual Lambda and SQS tests succeed.
STATE="${SCHEDULE_STATE:-DISABLED}"
[[ "$STATE" == DISABLED || "$STATE" == ENABLED ]] || exit 1
if awsl scheduler get-schedule --name parking-allocation-sweep >/dev/null 2>&1; then cmd=update-schedule; else cmd=create-schedule; fi
awsl scheduler "$cmd" --name parking-allocation-sweep --schedule-expression 'rate(1 minute)' --flexible-time-window Mode=OFF --target "$TARGET" --state "$STATE" >/dev/null
echo "EventBridge Scheduler configured: $STATE. Verify actual automatic execution before reporting it."
