const {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const db = require("../../config/dynamodb");
const tables = require("../../config/tables");
const { ApiError } = require("../../services/errors");
const { setTimeout: pause } = require("node:timers/promises");

async function get(table, id) {
  const { name, key } = tables[table];
  const result = await db.send(
    new GetCommand({
      TableName: name,
      Key: { [key]: id },
      ConsistentRead: true,
    }),
  );
  return result.Item || null;
}
async function list(table) {
  const rows = [];
  let lastKey;
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: tables[table].name,
        ExclusiveStartKey: lastKey,
        ConsistentRead: true,
      }),
    );
    rows.push(...page.Items);
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return rows;
}
function save(table, item) {
  return { Put: { TableName: tables[table].name, Item: item } };
}
function remove(table, id) {
  return {
    Delete: { TableName: tables[table].name, Key: { [tables[table].key]: id } },
  };
}
// Read the version BEFORE planning a change. Another writer invalidates our plan.
// All changes and the version increment succeed together. Conflicts get a fresh plan.
async function change(plan) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const guard = await get("rules", "version");
    if (!guard) throw new ApiError(503, "SETUP_REQUIRED", "Run npm run setup.");
    const { writes, result } = await plan();
    if (!writes.length) return result;
    const bump = {
      Update: {
        TableName: tables.rules.name,
        Key: { rule_id: "version" },
        UpdateExpression: "SET #v = #v + :one",
        ConditionExpression: "#v = :expected",
        ExpressionAttributeNames: { "#v": "version" },
        ExpressionAttributeValues: { ":one": 1, ":expected": guard.version },
      },
    };
    try {
      await db.send(
        new TransactWriteCommand({ TransactItems: [bump, ...writes] }),
      );
      return result;
    } catch (e) {
      const retryable =
        e.name === "TransactionConflictException" ||
        (e.name === "TransactionCanceledException" &&
          (!e.CancellationReasons ||
            e.CancellationReasons.every((r) =>
              [
                "None",
                "ConditionalCheckFailed",
                "TransactionConflict",
              ].includes(r.Code),
            )));
      if (!retryable) throw e;
      await pause(10 * (attempt + 1) + Math.random() * 30);
    }
  }
  throw new ApiError(503, "BUSY", "Allocation is busy. Retry the request.");
}
module.exports = { get, list, save, remove, change };
