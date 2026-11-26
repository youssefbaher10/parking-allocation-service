#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/services/_lib.sh"
mkdir -p .local/runtime
OUT=$(node -p 'require("node:path").resolve(".local/runtime/lambda-result.json").replace(/\\/g,"/")')
# This sweep may expire real demo records. Use a dedicated demo environment.
[[ "${1:-}" == --confirm-demo ]] || { echo 'Use --confirm-demo to run maintenance on the current local tables.'; exit 1; }
awsl lambda invoke --function-name parking-allocation-sweep --cli-binary-format raw-in-base64-out --payload '{}' "$OUT" --output json > .local/runtime/lambda-meta.json
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(".local/runtime/lambda-meta.json","utf8"));const r=JSON.parse(fs.readFileSync(".local/runtime/lambda-result.json","utf8"));if(m.FunctionError||m.StatusCode!==200||!Number.isInteger(r.expired)||!Number.isInteger(r.groups_checked))throw Error("Lambda did not return a valid sweep result");console.log(r)'
Q=$(awsl sqs get-queue-url --queue-name parking-allocation-maintenance --query QueueUrl --output text)
awsl sqs send-message --queue-url "$Q" --message-body '{"type":"allocation_sweep"}' --query MessageId --output text
 echo 'Message accepted. Check Lambda logs and queue attributes to confirm consumption; sending alone is not proof.'
