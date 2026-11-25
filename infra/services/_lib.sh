#!/usr/bin/env bash
# Adapted from Lab 8: all AWS CLI calls are pinned to local Floci.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECT_ROOT="$(cd "$LIB_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"
export AWS_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1 AWS_PROFILE=floci
export ENDPOINT=http://localhost:4566 DYNAMODB_ENDPOINT=http://localhost:4566
export AWS_PAGER="" AWS_EC2_METADATA_DISABLED=true
# Use local emulator credentials from the floci profile, not ambient AWS credentials.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN
awsl() {
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' aws --endpoint-url "$ENDPOINT" --profile floci --region us-east-1 --no-cli-pager "$@"
}
need() { command -v "$1" >/dev/null || { echo "Missing $1" >&2; return 1; }; }
exists() { [[ -n "$1" && "$1" != None && "$1" != null ]]; }
# Only tolerate explicitly listed duplicate errors; do not hide other errors.
allow_duplicate() {
  local pattern="$1" out; shift
  if ! out=$("$@" 2>&1); then
    if ! grep -Eq "$pattern" <<< "$out"; then printf '%s\n' "$out" >&2; return 1; fi
  fi
}
account() { awsl sts get-caller-identity --query Account --output text; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
jsonfile() { node -p 'require("node:url").pathToFileURL(require("node:path").resolve(process.argv[1])).href' "$1"; }
# AWS CLI expects file:// followed by native path, not a URL-encoded path.
cli_file() { printf 'file://%s' "$(node -p 'require("node:path").resolve(process.argv[1]).replace(/\\/g,"/")' "$1")"; }
