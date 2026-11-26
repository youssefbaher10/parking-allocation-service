
#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# Configure CloudTrail and S3 audit storage.
ACCOUNT_ID=$(account)
BUCKET=parking-cloudtrail-audit
TRAIL=parking-audit
TEST_BUCKET=parking-audit-test-source

# Create the audit storage bucket.
allow_duplicate 'BucketAlreadyOwnedByYou|BucketAlreadyExists' \
  awsl s3api create-bucket --bucket "$BUCKET"

# Allow CloudTrail to deliver audit logs to S3.
POLICY=$(node -e '
const [b,a,t]=process.argv.slice(1);
const source=`arn:aws:cloudtrail:us-east-1:${a}:trail/${t}`;

console.log(JSON.stringify({
  Version:"2012-10-17",
  Statement:[
    {
      Effect:"Allow",
      Principal:{Service:"cloudtrail.amazonaws.com"},
      Action:"s3:GetBucketAcl",
      Resource:`arn:aws:s3:::${b}`,
      Condition:{
        StringEquals:{"aws:SourceArn":source}
      }
    },
    {
      Effect:"Allow",
      Principal:{Service:"cloudtrail.amazonaws.com"},
      Action:"s3:PutObject",
      Resource:`arn:aws:s3:::${b}/AWSLogs/${a}/*`,
      Condition:{
        StringEquals:{
          "s3:x-amz-acl":"bucket-owner-full-control",
          "aws:SourceArn":source
        }
      }
    }
  ]
}))' "$BUCKET" "$ACCOUNT_ID" "$TRAIL")

awsl s3api put-bucket-policy \
  --bucket "$BUCKET" \
  --policy "$POLICY"

# Create CloudTrail if it does not already exist.
OLD=$(awsl cloudtrail describe-trails \
  --trail-name-list "$TRAIL" \
  --query 'trailList[0].Name' \
  --output text)

if ! exists "$OLD"; then
  awsl cloudtrail create-trail \
    --name "$TRAIL" \
    --s3-bucket-name "$BUCKET" >/dev/null
fi

# Create a separate bucket for controlled audit testing.
allow_duplicate 'BucketAlreadyOwnedByYou|BucketAlreadyExists' \
  awsl s3api create-bucket --bucket "$TEST_BUCKET"

# Enable management events and S3 object data events
# for the controlled test bucket.
awsl cloudtrail put-event-selectors \
  --trail-name "$TRAIL" \
  --event-selectors '[{"ReadWriteType":"All","IncludeManagementEvents":true,"DataResources":[{"Type":"AWS::S3::Object","Values":["arn:aws:s3:::parking-audit-test-source/"]}]}]'

# Enable CloudTrail logging.
awsl cloudtrail start-logging --name "$TRAIL"

# Verify trail status.
awsl cloudtrail get-trail-status --name "$TRAIL"

echo "CloudTrail and S3 audit storage configured."
