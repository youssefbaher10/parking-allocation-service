
// Helper for JSON/secret files.
// Bash performs AWS provisioning.

const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config({ quiet: true });

const t = require("../../src/config/tables");

const base = ".local/runtime";

fs.mkdirSync(base, {
  recursive: true,
  mode: 0o700,
});

const write = (name, value) =>
  fs.writeFileSync(
    path.join(base, name),
    JSON.stringify(value, null, 2),
    { mode: 0o600 }
  );

const [mode, account] = process.argv.slice(2);
const region = "us-east-1";

const arn = (service, resource) =>
  `arn:aws:${service}:${region}:${account}:${resource}`;

const roleArn = (name) =>
  `arn:aws:iam::${account}:role/parking-allocation-${name}`;

const allow = (Action, Resource) => ({
  Effect: "Allow",
  Action,
  Resource,
});

const policy = (Statement) => ({
  Version: "2012-10-17",
  Statement,
});

// DynamoDB permissions
const db = allow(
  [
    "dynamodb:GetItem",
    "dynamodb:Scan",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:ConditionCheckItem",
  ],
  Object.values(t).map((x) =>
    arn("dynamodb", "table/" + x.name)
  )
);

// SQS configuration
const queue = arn(
  "sqs",
  "parking-allocation-maintenance"
);

const queueRead = allow(
  [
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes",
  ],
  queue
);

// CloudWatch permissions
const log = (name) =>
  arn("logs", "log-group:" + name + ":*");

// Required Secrets Manager entries
const inventoryMode =
  process.env.INVENTORY_MODE || "sample";

const secretKeys = [
  "validity",
  "cognito-users",
];

if (inventoryMode === "http") {
  secretKeys.push("inventory");
}

// Common backend environment
const env = {
  AWS_REGION: region,
  DYNAMODB_ENDPOINT: "http://floci:4566",

  PARKING_REQUESTS_TABLE: t.requests.name,
  RESERVATIONS_TABLE: t.reservations.name,
  WAITLIST_TABLE: t.waiting.name,
  PRICING_TABLE: t.rules.name,

  INVENTORY_MODE: inventoryMode,
  INVENTORY_URL:
    process.env.CONTAINER_INVENTORY_URL || "",

  FRONTEND_ORIGIN:
    process.env.FRONTEND_ORIGIN || "",

  RATE_LIMIT: process.env.RATE_LIMIT || "120",
  PORT: "3001",
};

// Secrets Manager configuration
if (mode === "secrets") {
  const users = (
    process.env.COGNITO_USERS_JSON?.trim() ||
    fs.readFileSync(
      process.env.COGNITO_USERS_FILE,
      "utf8"
    )
  );

  const mapping = JSON.parse(users);

  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    Object.keys(mapping).length === 0
  ) {
    throw Error("Invalid Cognito identity mapping.");
  }

  const keys = {
    validity: process.env.INTERNAL_TOKEN,
    "cognito-users": users,
  };

  if (inventoryMode === "http") {
    keys.inventory = process.env.INVENTORY_TOKEN;
  }

  if (
    !keys.validity ||
    Buffer.byteLength(keys.validity) < 32
  ) {
    throw Error("Set a strong INTERNAL_TOKEN.");
  }

  if (
    inventoryMode === "http" &&
    !keys.inventory
  ) {
    throw Error("Missing INVENTORY_TOKEN.");
  }

  const dir = path.join(base, "secrets");

  fs.rmSync(dir, {
    recursive: true,
    force: true,
  });

  fs.mkdirSync(dir, {
    mode: 0o700,
  });

  for (const [key, value] of Object.entries(keys)) {
    fs.writeFileSync(
      path.join(dir, key + ".txt"),
      value,
      { mode: 0o600 }
    );
  }

// Remove temporary secret files
} else if (mode === "clean-secrets") {
  fs.rmSync(path.join(base, "secrets"), {
    recursive: true,
    force: true,
  });

// IAM policies
} else if (mode === "policies") {
  const statements = {
    task: [db],

    execution: [
      allow(
        "secretsmanager:GetSecretValue",
        secretKeys.map((key) =>
          arn(
            "secretsmanager",
            "secret:parking/allocation/" + key + "*"
          )
        )
      ),

      allow(
        [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        log("/aws/ecs/parking-allocation")
      ),
    ],

    lambda: [
      db,
      queueRead,

      allow(
        [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        log("/aws/lambda/parking-allocation-sweep")
      ),
    ],

    scheduler: [
      allow("sqs:SendMessage", queue),
    ],
  };

  const principals = {
    task: "ecs-tasks",
    execution: "ecs-tasks",
    lambda: "lambda",
    scheduler: "scheduler",
  };

  for (const [kind, principal] of Object.entries(
    principals
  )) {
    write(
      kind + "-trust.json",
      policy([
        {
          Effect: "Allow",
          Principal: {
            Service: principal + ".amazonaws.com",
          },
          Action: "sts:AssumeRole",
        },
      ])
    );

    write(
      kind + "-policy.json",
      policy(statements[kind])
    );
  }

// ECS task definition
} else if (mode === "task") {
  const required = [
    "COGNITO_REGION",
    "COGNITO_USER_POOL_ID",
    "COGNITO_CLIENT_ID",
    "COGNITO_ISSUER",
  ];

  for (const name of required) {
    if (!process.env[name]?.trim()) {
      throw Error("Missing Cognito configuration: " + name);
    }
  }

  const poolId =
    process.env.COGNITO_USER_POOL_ID;

  const taskEnv = {
    ...env,

    AUTH_MODE: "cognito",

    COGNITO_REGION:
      process.env.COGNITO_REGION,

    COGNITO_ENDPOINT:
      "http://floci:4566",

    COGNITO_USER_POOL_ID: poolId,

    COGNITO_CLIENT_ID:
      process.env.COGNITO_CLIENT_ID,

    COGNITO_ISSUER:
      process.env.COGNITO_ISSUER,

    COGNITO_JWKS_URL:
      "http://floci:4566/" +
      poolId +
      "/.well-known/jwks.json",
  };

  if (
    inventoryMode === "http" &&
    !taskEnv.INVENTORY_URL
  ) {
    throw Error("Missing CONTAINER_INVENTORY_URL.");
  }

  // Read actual secret ARNs discovered by AWS CLI
  const secretMap = JSON.parse(
    fs.readFileSync(
      path.join(base, "secret-arns.json"),
      "utf8"
    )
  );

  const names = {
    validity: "INTERNAL_TOKEN",
    inventory: "INVENTORY_TOKEN",
    "cognito-users": "COGNITO_USERS_JSON",
  };

  for (const key of secretKeys) {
    if (!secretMap[key]) {
      throw Error(
        "Missing secret ARN: " + key +
        ". Run secrets setup first."
      );
    }
  }

  write("task.json", {
    family: "parking-allocation",
    cpu: "256",
    memory: "512",
    networkMode: "awsvpc",

    requiresCompatibilities: [
      "FARGATE",
    ],

    taskRoleArn: roleArn("task"),
    executionRoleArn: roleArn("execution"),

    containerDefinitions: [
      {
        name: "allocation",
        image: "parking-allocation:local",
        essential: true,

        portMappings: [
          {
            containerPort: 3001,
            protocol: "tcp",
          },
        ],

        environment: Object.entries(taskEnv).map(
          ([name, value]) => ({
            name,
            value,
          })
        ),

        secrets: secretKeys.map((key) => ({
          name: names[key],
          valueFrom: secretMap[key],
        })),

        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group":
              "/aws/ecs/parking-allocation",

            "awslogs-region": region,

            "awslogs-stream-prefix":
              "allocation",
          },
        },
      },
    ],
  });

// Lambda configuration
} else if (mode === "lambda") {
  if (inventoryMode !== "sample") {
    throw Error(
      "Lambda setup currently supports sample Inventory only. " +
      "Configure secure HTTP inventory integration before " +
      "enabling team maintenance."
    );
  }

  // Lambda maintenance does not require user authentication
  const endpoint =
    process.env.LAMBDA_DYNAMODB_ENDPOINT ||
    "http://host.docker.internal:4566";

  if (
    ![
      "host.docker.internal",
      "floci",
      "localhost",
      "127.0.0.1",
    ].includes(new URL(endpoint).hostname)
  ) {
    throw Error("Use a local Floci endpoint.");
  }

  const variables = {
    ...env,
    DYNAMODB_ENDPOINT: endpoint,
  };

  delete variables.AWS_REGION;
  delete variables.PORT;
  delete variables.FRONTEND_ORIGIN;

  write("lambda-env.json", {
    Variables: variables,
  });

} else {
  throw Error("Unknown config command");
}
