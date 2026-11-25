// Run once in Git Bash. Existing .env settings and accounts are preserved.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const { randomBytes } = crypto;
function createDemo(root = ".") {
  const folder = path.join(root, ".local");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(root, ".env");
  const current = fs.existsSync(file)
    ? dotenv.parse(fs.readFileSync(file))
    : {};
  const defaults = {
    PORT: "3001",
    AWS_REGION: "us-east-1",
    AWS_PROFILE: "floci",
    DYNAMODB_ENDPOINT: "http://localhost:4566",
    PARKING_REQUESTS_TABLE: "ParkingRequests",
    INVENTORY_MODE: "sample",
    AUTH_SECRET: randomBytes(48).toString("hex"),
    INTERNAL_TOKEN: randomBytes(48).toString("hex"),
    ACCOUNTS_FILE: ".local/accounts.json",
  };
  const lines = Object.entries(defaults)
    .filter(([k]) => !current[k])
    .map(([k, v]) => k + "=" + v);
  if (lines.length)
    fs.appendFileSync(file, "\n" + lines.join("\n") + "\n", { mode: 0o600 });
  const accountsPath = path.join(folder, "accounts.json");
  if (fs.existsSync(accountsPath)) return;
  const accounts = [];
  for (const [user_id, role, priority] of [
    ["student1", "user", 1],
    ["student2", "user", 1],
    ["priority1", "user", 2],
    ["admin1", "admin", 1],
  ]) {
    const password = randomBytes(12).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    accounts.push({ user_id, role, priority, salt, hash });
    console.log("Local demo login:", user_id, password);
  }
  fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}
if (require.main === module) {
  createDemo();
  console.log("Keep the printed passwords locally. Run npm run setup next.");
}
module.exports = createDemo;
