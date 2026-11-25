require("dotenv").config({ quiet: true });
const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} = require("@aws-sdk/client-dynamodb");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const db = require("../src/config/dynamodb");
const tables = require("../src/config/tables");
async function setup() {
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION,
    endpoint: process.env.DYNAMODB_ENDPOINT,
  });
  try {
    for (const { name, key } of Object.values(tables)) {
      try {
        await client.send(
          new CreateTableCommand({
            TableName: name,
            BillingMode: "PAY_PER_REQUEST",
            AttributeDefinitions: [{ AttributeName: key, AttributeType: "S" }],
            KeySchema: [{ AttributeName: key, KeyType: "HASH" }],
          }),
        );
      } catch (e) {
        if (e.name !== "ResourceInUseException") throw e;
      }
      await waitUntilTableExists(
        { client, maxWaitTime: 65, minDelay: 1, maxDelay: 4 },
        { TableName: name },
      );
      const { Table } = await client.send(
        new DescribeTableCommand({ TableName: name }),
      );
      if (
        Table.KeySchema.length !== 1 ||
        Table.KeySchema[0].AttributeName !== key ||
        !Table.AttributeDefinitions.some(
          (a) => a.AttributeName === key && a.AttributeType === "S",
        )
      ) {
        throw new Error("Unexpected key on existing table " + name);
      }
      console.log("Ready:", name);
    }
    for (const Item of [
      { rule_id: "version", version: 0 },
      {
        rule_id: "tariff",
        daily_hour_piastres: 1000,
        permanent_hour_piastres: 600,
        threshold: 0.8,
        surge_percent: 125,
      },
    ]) {
      try {
        await db.send(
          new PutCommand({
            TableName: tables.rules.name,
            Item,
            ConditionExpression: "attribute_not_exists(rule_id)",
          }),
        );
      } catch (e) {
        if (e.name !== "ConditionalCheckFailedException") throw e;
      }
    }
  } finally {
    client.destroy();
  }
}
if (require.main === module)
  setup().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = setup;
