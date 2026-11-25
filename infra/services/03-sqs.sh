#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

DLQ=$(awsl sqs create-queue --queue-name parking-allocation-maintenance-dlq --query QueueUrl --output text)
ARN=$(awsl sqs get-queue-attributes --queue-url "$DLQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)
Q=$(awsl sqs create-queue --queue-name parking-allocation-maintenance --attributes VisibilityTimeout=180,MessageRetentionPeriod=345600 --query QueueUrl --output text)
ATTR=$(node -e 'console.log(JSON.stringify({RedrivePolicy:JSON.stringify({deadLetterTargetArn:process.argv[1],maxReceiveCount:3})}))' "$ARN")
awsl sqs set-queue-attributes --queue-url "$Q" --attributes "$ATTR"
echo "Maintenance queue: $Q"
echo "Dead-letter queue: $DLQ"
