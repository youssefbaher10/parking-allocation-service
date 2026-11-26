
#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# Clean temporary secret files when the script exits
trap 'node infra/runtime/config.cjs clean-secrets' EXIT

# Generate temporary secret files
node infra/runtime/config.cjs secrets

# Configure the secrets required by the Allocation Service
for key in validity inventory cognito-users; do

  file=".local/runtime/secrets/$key.txt"

  [[ -f "$file" ]] || continue

  name="parking/allocation/$key"

  if awsl secretsmanager describe-secret \
    --secret-id "$name" >/dev/null 2>&1; then

    awsl secretsmanager put-secret-value \
      --secret-id "$name" \
      --secret-string "$(cli_file "$file")" >/dev/null

  else

    awsl secretsmanager create-secret \
      --name "$name" \
      --secret-string "$(cli_file "$file")" >/dev/null

  fi

  echo "Configured secret: $name (value hidden)"

done

echo "Allocation Secrets Manager configuration completed."
