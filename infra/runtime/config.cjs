// Helper for JSON/secret files; Bash performs AWS provisioning.
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({quiet:true});
const t = require('../../src/config/tables');
const base = '.local/runtime';
fs.mkdirSync(base,{recursive:true,mode:0o700});
const write = (name,value) => fs.writeFileSync(path.join(base,name),JSON.stringify(value,null,2),{mode:0o600});
const [mode,account] = process.argv.slice(2);
const region = 'us-east-1';
const arn = (service,resource) => `arn:aws:${service}:${region}:${account}:${resource}`;
const roleArn = name => `arn:aws:iam::${account}:role/parking-allocation-${name}`;
const allow = (Action,Resource) => ({Effect:'Allow',Action,Resource});
const policy = Statement => ({Version:'2012-10-17',Statement});
const db = allow(['dynamodb:GetItem','dynamodb:Scan','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:ConditionCheckItem'],Object.values(t).map(x=>arn('dynamodb','table/'+x.name)));
const queue = arn('sqs','parking-allocation-maintenance');
const log = name => arn('logs','log-group:'+name+':*');
const queueRead = allow(['sqs:ReceiveMessage','sqs:DeleteMessage','sqs:GetQueueAttributes'],queue);
const keys = {auth:process.env.AUTH_SECRET,validity:process.env.INTERNAL_TOKEN};
if(process.env.INVENTORY_MODE==='http') keys.inventory=process.env.INVENTORY_TOKEN;
if(process.env.ACCOUNTS_JSON) keys.accounts=process.env.ACCOUNTS_JSON;
else if(process.env.ACCOUNTS_FILE) keys.accounts=fs.readFileSync(process.env.ACCOUNTS_FILE,'utf8');
const env = {AWS_REGION:region,DYNAMODB_ENDPOINT:'http://floci:4566',PARKING_REQUESTS_TABLE:t.requests.name,RESERVATIONS_TABLE:t.reservations.name,WAITLIST_TABLE:t.waiting.name,PRICING_TABLE:t.rules.name,INVENTORY_MODE:process.env.INVENTORY_MODE||'sample',INVENTORY_URL:process.env.CONTAINER_INVENTORY_URL||'',AUTH_ISSUER:process.env.AUTH_ISSUER||'parking-team',AUTH_AUDIENCE:process.env.AUTH_AUDIENCE||'parking-api',FRONTEND_ORIGIN:process.env.FRONTEND_ORIGIN||'',RATE_LIMIT:process.env.RATE_LIMIT||'120',PORT:'3001'};
if(mode==='secrets') {
  if(!keys.auth||!keys.validity||keys.auth.length<32||keys.validity.length<32||keys.auth===keys.validity|| (process.env.INVENTORY_MODE==='http'&&!keys.inventory)) throw Error('Local secrets missing; use your existing demo settings.');
  const dir=path.join(base,'secrets'); fs.rmSync(dir,{recursive:true,force:true}); fs.mkdirSync(dir,{mode:0o700});
  for(const [k,v] of Object.entries(keys)) if(v) fs.writeFileSync(path.join(dir,k+'.txt'),v,{mode:0o600});
} else if(mode==='clean-secrets') fs.rmSync(path.join(base,'secrets'),{recursive:true,force:true});
else if(mode==='policies') {
  const statements={task:[db],execution:[allow('secretsmanager:GetSecretValue',Object.keys(keys).filter(k=>keys[k]).map(k=>arn('secretsmanager','secret:parking/allocation/'+k+'*'))),allow(['logs:CreateLogStream','logs:PutLogEvents'],log('/aws/ecs/parking-allocation'))],lambda:[db,queueRead,allow(['logs:CreateLogStream','logs:PutLogEvents'],log('/aws/lambda/parking-allocation-sweep'))],scheduler:[allow('sqs:SendMessage',queue)]};
  for(const [kind,principal] of Object.entries({task:'ecs-tasks',execution:'ecs-tasks',lambda:'lambda',scheduler:'scheduler'})) {
    write(kind+'-trust.json',policy([{Effect:'Allow',Principal:{Service:principal+'.amazonaws.com'},Action:'sts:AssumeRole'}])); write(kind+'-policy.json',policy(statements[kind]));
  }
} else if(mode==='task') {
  // Use actual ARNs discovered by CLI, not guessed suffixes.
  const secretMap=JSON.parse(fs.readFileSync(path.join(base,'secret-arns.json'),'utf8'));
  const names={auth:'AUTH_SECRET',validity:'INTERNAL_TOKEN',inventory:'INVENTORY_TOKEN',accounts:'ACCOUNTS_JSON'};
  if(!secretMap.auth||!secretMap.validity) throw Error('Run secrets setup first');
  write('task.json',{family:'parking-allocation',cpu:'256',memory:'512',networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],taskRoleArn:roleArn('task'),executionRoleArn:roleArn('execution'),containerDefinitions:[{name:'allocation',image:'parking-allocation:local',essential:true,portMappings:[{containerPort:3001,protocol:'tcp'}],environment:Object.entries(env).map(([name,value])=>({name,value})),secrets:Object.entries(secretMap).map(([key,valueFrom])=>({name:names[key],valueFrom})),logConfiguration:{logDriver:'awslogs',options:{'awslogs-group':'/aws/ecs/parking-allocation','awslogs-region':region,'awslogs-stream-prefix':'allocation'}}}]});
} else if(mode==='lambda') {
  if(env.INVENTORY_MODE!=='sample') throw Error('Lambda setup currently supports sample Inventory only. Configure secure HTTP inventory integration before enabling team maintenance.');
  // No auth secrets needed by the business-layer sweep in sample mode.
  const endpoint=process.env.LAMBDA_DYNAMODB_ENDPOINT||'http://host.docker.internal:4566';
  if(!['host.docker.internal','floci','localhost','127.0.0.1'].includes(new URL(endpoint).hostname)) throw Error('Use a local Floci endpoint');
  const variables={...env,DYNAMODB_ENDPOINT:endpoint}; delete variables.AWS_REGION; delete variables.PORT; delete variables.FRONTEND_ORIGIN;
  write('lambda-env.json',{Variables:variables});
} else throw Error('Unknown config command');
