
#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/services/_lib.sh"

FAILED=0

check() {
  printf '\n=== %s ===\n' "$1"
  shift

  if ! awsl "$@"; then
    warn 'Check failed or operation unsupported'
    FAILED=1
  fi
}

# 1. DynamoDB
check '1. DynamoDB' \
  dynamodb list-tables \
  --output table

# 2. Cognito
check '2. Cognito' \
  cognito-idp list-user-pools \
  --max-results 20 \
  --query 'UserPools[].{Name:Name,ID:Id}' \
  --output table

# 3. Secrets Manager
# Display secret names only, never secret values.
check '3. Secrets Manager' \
  secretsmanager list-secrets \
  --query 'SecretList[?starts_with(Name, `parking/allocation/`)].Name' \
  --output table

# 4. IAM
check '4. IAM' \
  iam list-roles \
  --query 'Roles[?starts_with(RoleName, `parking-allocation-`)].RoleName' \
  --output table

# 5. VPC
check '5. VPC' \
  ec2 describe-vpcs \
  --filters Name=tag:Name,Values=parking-vpc \
  --query 'Vpcs[].{Id:VpcId,CIDR:CidrBlock}' \
  --output table

# 6. ECS
check '6. ECS' \
  ecs describe-services \
  --cluster parking-cluster \
  --services parking-allocation \
  --query '{Services:services[].{Name:serviceName,Desired:desiredCount,Running:runningCount,Status:status},Failures:failures}' \
  --output json

# 7. Application Load Balancer
check '7. ALB' \
  elbv2 describe-load-balancers \
  --query 'LoadBalancers[].{Name:LoadBalancerName,State:State.Code}' \
  --output table

check 'ALB Target Groups' \
  elbv2 describe-target-groups \
  --query 'TargetGroups[].{Name:TargetGroupName,Port:Port,Health:HealthCheckPath}' \
  --output table

# 8. SQS
check '8. SQS' \
  sqs list-queues \
  --queue-name-prefix parking-allocation \
  --output table

# 9. Lambda
check '9. Lambda' \
  lambda list-functions \
  --query 'Functions[].{Name:FunctionName,Runtime:Runtime}' \
  --output table

check 'Lambda SQS Event Source' \
  lambda list-event-source-mappings \
  --function-name parking-allocation-sweep \
  --query 'EventSourceMappings[].{State:State,Queue:EventSourceArn,Batch:BatchSize}' \
  --output table

# 10. EventBridge Scheduler
check '10. EventBridge Scheduler' \
  scheduler get-schedule \
  --name parking-allocation-sweep \
  --query '{Name:Name,State:State,Frequency:ScheduleExpression,Target:Target.Arn}' \
  --output table

# 11. CloudWatch
check '11. CloudWatch Log Groups' \
  logs describe-log-groups \
  --query 'logGroups[].logGroupName' \
  --output table

check 'CloudWatch Backend Log Streams' \
  logs describe-log-streams \
  --log-group-name /aws/ecs/parking-allocation \
  --query 'logStreams[].logStreamName' \
  --output table

# 12. Application Auto Scaling
check '12. Application Auto Scaling' \
  application-autoscaling describe-scalable-targets \
  --service-namespace ecs \
  --query 'ScalableTargets[].{Id:ResourceId,Min:MinCapacity,Max:MaxCapacity}' \
  --output table

check 'Auto Scaling Policies' \
  application-autoscaling describe-scaling-policies \
  --service-namespace ecs \
  --query 'ScalingPolicies[].{Name:PolicyName,Type:PolicyType,Target:TargetTrackingScalingPolicyConfiguration.TargetValue}' \
  --output table

# 13. S3
check '13. S3' \
  s3api list-buckets \
  --query 'Buckets[].Name' \
  --output table

# 14. CloudTrail
check '14. CloudTrail' \
  cloudtrail describe-trails \
  --trail-name-list parking-audit \
  --query 'trailList[].{Name:Name,Bucket:S3BucketName}' \
  --output table

check 'CloudTrail Logging Status' \
  cloudtrail get-trail-status \
  --name parking-audit

check 'CloudTrail Event Selectors' \
  cloudtrail get-event-selectors \
  --trail-name parking-audit

check 'CloudTrail Audit Files' \
  s3 ls s3://parking-cloudtrail-audit/ \
  --recursive

printf '\n========================================\n'
printf 'Cloud resource verification finished.\n'
printf '========================================\n'

if [[ "$FAILED" -eq 0 ]]; then
  echo "All resource inspection commands succeeded."
else
  echo "Some resource inspection commands failed."
fi

echo "Empty results must be investigated."
echo "Resource configuration is not proof of runtime execution."
echo "Local workers simulate horizontal scaling, not native ECS Auto Scaling."

exit "$FAILED"
