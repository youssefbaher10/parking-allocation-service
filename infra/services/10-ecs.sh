#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# Allocation only; teammates register their own services in the same cluster.
ACCOUNT_ID=$(account)
VPC=$(awsl ec2 describe-vpcs --filters Name=tag:Name,Values=parking-vpc --query 'Vpcs[0].VpcId' --output text)
A=$(awsl ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=cidr-block,Values=10.0.1.0/24 --query 'Subnets[0].SubnetId' --output text)
B=$(awsl ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=cidr-block,Values=10.0.2.0/24 --query 'Subnets[0].SubnetId' --output text)
SG=$(awsl ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC" Name=group-name,Values=parking-backend-sg --query 'SecurityGroups[0].GroupId' --output text)
TG=$(awsl elbv2 describe-target-groups --names parking-allocation-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
for id in "$VPC" "$A" "$B" "$SG" "$TG"; do exists "$id" || { echo 'Run 09-elbv2.sh first' >&2; exit 1; }; done
awsl ecs create-cluster --cluster-name parking-cluster >/dev/null
mkdir -p .local/runtime
# List names only; never fetch secret values for the task definition.
awsl secretsmanager list-secrets --query 'SecretList[?starts_with(Name, `parking/allocation/`)].{Name:Name,ARN:ARN}' --output json > .local/runtime/secret-list.json
node -e 'const fs=require("fs");const rows=JSON.parse(fs.readFileSync(".local/runtime/secret-list.json","utf8"));const keys=["auth","validity","inventory","accounts"];fs.writeFileSync(".local/runtime/secret-arns.json",JSON.stringify(Object.fromEntries(rows.map(x=>[x.Name.split("/").pop(),x.ARN]).filter(([k])=>keys.includes(k)))))'
node infra/runtime/config.cjs task "$ACCOUNT_ID"
# Build the image so a Floci version with native task execution can find it.
if [[ "${BUILD_IMAGE:-0}" == 1 ]]; then docker build -t parking-allocation:local .; fi
TASK=$(awsl ecs register-task-definition --cli-input-json "$(cli_file .local/runtime/task.json)" --query taskDefinition.taskDefinitionArn --output text)
OLD=$(awsl ecs describe-services --cluster parking-cluster --services parking-allocation --query 'services[?status==`ACTIVE`].serviceName | [0]' --output text)
# In the Lab 8 recorded-resource mode, desired count mirrors local workers.
# If native execution is enabled, do not start local replicas in parallel.
if exists "$OLD"; then
  awsl ecs update-service --cluster parking-cluster --service parking-allocation --task-definition "$TASK" --desired-count 1 >/dev/null
else
  awsl ecs create-service --cluster parking-cluster --service-name parking-allocation --task-definition "$TASK" --desired-count 1 --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$A,$B],securityGroups=[$SG],assignPublicIp=DISABLED}" --load-balancers "targetGroupArn=$TG,containerName=allocation,containerPort=3001" >/dev/null
fi
awsl application-autoscaling register-scalable-target --service-namespace ecs --resource-id service/parking-cluster/parking-allocation --scalable-dimension ecs:service:DesiredCount --min-capacity 1 --max-capacity 4 || warn 'Auto Scaling target not recorded; manual local scaling remains possible.'
awsl application-autoscaling put-scaling-policy --service-namespace ecs --resource-id service/parking-cluster/parking-allocation --scalable-dimension ecs:service:DesiredCount --policy-name parking-allocation-cpu --policy-type TargetTrackingScaling --target-tracking-scaling-policy-configuration '{"TargetValue":50.0,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"}}' >/dev/null || warn 'Auto Scaling policy not recorded.'
awsl ecs describe-services --cluster parking-cluster --services parking-allocation --query 'services[].{Name:serviceName,Desired:desiredCount,Running:runningCount}' --output table
