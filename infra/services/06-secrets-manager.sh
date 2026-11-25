#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# Values are written to private ignored files, never passed as CLI arguments.
node infra/runtime/config.cjs secrets
trap 'node infra/runtime/config.cjs clean-secrets' EXIT
for key in auth validity inventory accounts; do
  file=".local/runtime/secrets/$key.txt"
  [[ -f "$file" ]] || continue
  name="parking/allocation/$key"
  if awsl secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    awsl secretsmanager put-secret-value --secret-id "$name" --secret-string "$(cli_file "$file")" >/dev/null
  else
    awsl secretsmanager create-secret --name "$name" --secret-string "$(cli_file "$file")" >/dev/null
  fi
  echo "Configured secret: $name (value hidden)"
done
