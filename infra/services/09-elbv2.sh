#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# Reuse the existing parking VPC created by network.js, or create it if absent.
VPC=$(awsl ec2 describe-vpcs --filters Name=tag:Name,Values=parking-vpc --query 'Vpcs[0].VpcId' --output text)
if ! exists "$VPC"; then
  VPC=$(awsl ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=parking-vpc}]' --query Vpc.VpcId --output text)
fi
[[ $(awsl ec2 describe-vpcs --vpc-ids "$VPC" --query 'Vpcs[0].CidrBlock' --output text) == 10.0.0.0/16 ]] || { echo 'Unexpected parking VPC CIDR' >&2; exit 1; }
subnet() {
  local id
  id=$(awsl ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" "Name=cidr-block,Values=$1" --query 'Subnets[0].SubnetId' --output text)
  if ! exists "$id"; then id=$(awsl ec2 create-subnet --vpc-id "$VPC" --cidr-block "$1" --availability-zone "$2" --query Subnet.SubnetId --output text); fi
  [[ $(awsl ec2 describe-subnets --subnet-ids "$id" --query 'Subnets[0].AvailabilityZone' --output text) == "$2" ]] || { echo 'Subnet availability zone mismatch' >&2; return 1; }
  printf '%s' "$id"
}
A=$(subnet 10.0.1.0/24 us-east-1a); B=$(subnet 10.0.2.0/24 us-east-1b)
sg() {
  local id; id=$(awsl ec2 describe-security-groups --filters "Name=group-name,Values=$1" "Name=vpc-id,Values=$VPC" --query 'SecurityGroups[0].GroupId' --output text)
  if ! exists "$id"; then id=$(awsl ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC" --query GroupId --output text); fi
  printf '%s' "$id"
}
ALBSG=$(sg parking-alb-sg 'HTTP ingress for lab ALB'); BACKSG=$(sg parking-backend-sg 'Backend ingress from shared ALB and backend group')
allow_duplicate 'InvalidPermission.Duplicate' awsl ec2 authorize-security-group-ingress --group-id "$ALBSG" --protocol tcp --port 80 --cidr 0.0.0.0/0
for port in 3001 3002 3003; do
  for source in "$ALBSG" "$BACKSG"; do
    allow_duplicate 'InvalidPermission.Duplicate' awsl ec2 authorize-security-group-ingress --group-id "$BACKSG" --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,UserIdGroupPairs=[{GroupId=$source}]"
  done
done
ALB=$(awsl elbv2 describe-load-balancers --query "LoadBalancers[?LoadBalancerName=='parking-alb'].LoadBalancerArn | [0]" --output text)
if ! exists "$ALB"; then ALB=$(awsl elbv2 create-load-balancer --name parking-alb --subnets "$A" "$B" --security-groups "$ALBSG" --type application --query 'LoadBalancers[0].LoadBalancerArn' --output text); fi
[[ $(awsl elbv2 describe-load-balancers --load-balancer-arns "$ALB" --query 'LoadBalancers[0].VpcId' --output text) == "$VPC" ]] || { echo 'Existing ALB belongs to a different VPC' >&2; exit 1; }
for spec in allocation:3001:40 inventory:3002:50 incidents:3003:60; do
  IFS=: read -r name port priority <<< "$spec"
  TG=$(awsl elbv2 describe-target-groups --query "TargetGroups[?TargetGroupName=='parking-$name-tg'].TargetGroupArn | [0]" --output text)
  if ! exists "$TG"; then TG=$(awsl elbv2 create-target-group --name "parking-$name-tg" --protocol HTTP --port "$port" --vpc-id "$VPC" --target-type ip --health-check-path /health --query 'TargetGroups[0].TargetGroupArn' --output text); fi
  [[ $(awsl elbv2 describe-target-groups --target-group-arns "$TG" --query 'TargetGroups[0].VpcId' --output text) == "$VPC" ]] || { echo 'Target group VPC mismatch' >&2; exit 1; }
  LISTENER=$(awsl elbv2 describe-listeners --load-balancer-arn "$ALB" --query 'Listeners[?Port==`80`].ListenerArn | [0]' --output text)
  if ! exists "$LISTENER"; then
    LISTENER=$(awsl elbv2 create-listener --load-balancer-arn "$ALB" --protocol HTTP --port 80 --default-actions '[{"Type":"fixed-response","FixedResponseConfig":{"StatusCode":"404","ContentType":"text/plain","MessageBody":"Not found"}}]' --query 'Listeners[0].ListenerArn' --output text)
  fi
  EXISTING=$(awsl elbv2 describe-rules --listener-arn "$LISTENER" --query "Rules[?Priority=='$priority'].RuleArn | [0]" --output text)
  if exists "$EXISTING"; then
    ACTUAL=$(awsl elbv2 describe-rules --rule-arns "$EXISTING" --query 'Rules[0].Actions[0].TargetGroupArn' --output text)
    PATHS=$(awsl elbv2 describe-rules --rule-arns "$EXISTING" --query 'Rules[0].Conditions[].Values[]' --output text)
    [[ "$ACTUAL" == "$TG" && "$PATHS" == *"/api/$name/*"* ]] || { echo "Rule priority $priority conflicts" >&2; exit 1; }
  else
    awsl elbv2 create-rule --listener-arn "$LISTENER" --priority "$priority" --conditions "Field=path-pattern,Values=/api/$name/*" --actions "Type=forward,TargetGroupArn=$TG" >/dev/null
  fi
  echo "Target group: parking-$name-tg -> $TG"
done
printf 'VPC: %s\nSubnets: %s %s\nALB security group: %s\nBackend security group: %s\nALB: %s\nListener: %s\n' "$VPC" "$A" "$B" "$ALBSG" "$BACKSG" "$ALB" "$LISTENER"
echo 'Control-plane configuration only; local proxy provides traffic in Lab 8 mode.'
