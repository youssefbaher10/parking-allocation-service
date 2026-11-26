#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# Optional, actual runtime support depends on the installed Floci build.
# Package existing sweep logic; no edits to the backend.
ACCOUNT_ID=$(account)
node infra/runtime/config.cjs lambda "$ACCOUNT_ID"
node -e 'require("esbuild").buildSync({entryPoints:["infra/runtime/sweep-handler.cjs"],bundle:true,platform:"node",target:"node22",format:"cjs",outfile:".local/runtime/lambda/index.js"});const Zip=require("adm-zip");const z=new Zip();z.addLocalFile(".local/runtime/lambda/index.js");z.writeZip(".local/runtime/sweep.zip")'
NAME=parking-allocation-sweep
ZIP="fileb://$(node -p 'require("node:path").resolve(".local/runtime/sweep.zip").replace(/\\/g,"/")')"
ENVFILE=$(cli_file .local/runtime/lambda-env.json)
if awsl lambda get-function --function-name "$NAME" >/dev/null 2>&1; then
  awsl lambda update-function-code --function-name "$NAME" --zip-file "$ZIP" >/dev/null
  awsl lambda update-function-configuration --function-name "$NAME" --environment "$ENVFILE" --timeout 60 >/dev/null
else
  awsl lambda create-function --function-name "$NAME" --runtime nodejs22.x --handler index.handler --role "arn:aws:iam::$ACCOUNT_ID:role/parking-allocation-lambda" --zip-file "$ZIP" --environment "$ENVFILE" --timeout 60 --memory-size 256 >/dev/null
fi
Q=$(awsl sqs get-queue-url --queue-name parking-allocation-maintenance --query QueueUrl --output text)
ARN=$(awsl sqs get-queue-attributes --queue-url "$Q" --attribute-names QueueArn --query Attributes.QueueArn --output text)
MAP=$(awsl lambda list-event-source-mappings --function-name "$NAME" --event-source-arn "$ARN" --query 'EventSourceMappings[0].UUID' --output text)
if ! exists "$MAP"; then awsl lambda create-event-source-mapping --function-name "$NAME" --event-source-arn "$ARN" --batch-size 1 >/dev/null; fi
echo 'Lambda and queue mapping configured; verify invocation before claiming successful execution.'
