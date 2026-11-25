#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

ACCOUNT_ID=$(account)
node infra/runtime/config.cjs policies "$ACCOUNT_ID"
for kind in task execution lambda scheduler; do
  name="parking-allocation-$kind"
  allow_duplicate 'EntityAlreadyExists' awsl iam create-role --role-name "$name" --assume-role-policy-document "$(cli_file .local/runtime/$kind-trust.json)" >/dev/null
  awsl iam put-role-policy --role-name "$name" --policy-name allocation --policy-document "$(cli_file .local/runtime/$kind-policy.json)"
  echo "IAM role: $name"
done
