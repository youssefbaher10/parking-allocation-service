
#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

POOL_NAME="parking-users"
CLIENT_NAME="parking-web-client"

# Create or reuse the User Pool
POOL_ID=$(awsl cognito-idp list-user-pools \
  --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" \
  --output text)

if [[ -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
  POOL_ID=$(awsl cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" \
    --policies '{"PasswordPolicy":{"MinimumLength":8,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":true}}' \
    --admin-create-user-config AllowAdminCreateUserOnly=true \
    --query 'UserPool.Id' \
    --output text)
fi

echo "User Pool: $POOL_ID"

# Create or reuse the App Client
CLIENT_ID=$(awsl cognito-idp list-user-pool-clients \
  --user-pool-id "$POOL_ID" \
  --max-results 60 \
  --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]" \
  --output text)

if [[ -z "$CLIENT_ID" || "$CLIENT_ID" == "None" ]]; then
  CLIENT_ID=$(awsl cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --prevent-user-existence-errors ENABLED \
    --query 'UserPoolClient.ClientId' \
    --output text)
fi

echo "App Client: $CLIENT_ID"

# Create user and admin groups
for GROUP in user admin; do
  EXISTING=$(awsl cognito-idp list-groups \
    --user-pool-id "$POOL_ID" \
    --query "Groups[?GroupName=='$GROUP'].GroupName | [0]" \
    --output text)

  if [[ -z "$EXISTING" || "$EXISTING" == "None" ]]; then
    awsl cognito-idp create-group \
      --user-pool-id "$POOL_ID" \
      --group-name "$GROUP" >/dev/null
  fi

  echo "Group configured: $GROUP"
done

# Save Cognito configuration
mkdir -p .local/runtime

node -e 'const fs = require("fs");
fs.writeFileSync(".local/runtime/cognito.json",
JSON.stringify({
  userPoolId: process.argv[1],
  clientId: process.argv[2],
  region: "us-east-1"
}, null, 2));' "$POOL_ID" "$CLIENT_ID"

echo "Cognito configuration completed."
