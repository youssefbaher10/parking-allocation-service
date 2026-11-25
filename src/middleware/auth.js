const jwt = require("jsonwebtoken");
const { timingSafeEqual, scrypt: deriveKey } = require("node:crypto");
const { promisify } = require("node:util");
const fs = require("node:fs");
const { ApiError } = require("../services/errors");
const { only } = require("../services/rules");
const scrypt = promisify(deriveKey);
const issuer = () => process.env.AUTH_ISSUER || "parking-team";
const audience = () => process.env.AUTH_AUDIENCE || "parking-api";
const denied = () =>
  new ApiError(401, "UNAUTHORIZED", "Valid credentials are required.");
function secret(name) {
  const value = process.env[name];
  if (!value || Buffer.byteLength(value) < 32)
    throw new Error("Set a strong " + name + " before starting.");
  return value;
}
function user(req, res, next) {
  const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
  try {
    if (!req.get("Authorization")?.startsWith("Bearer ")) throw denied();
    const claims = jwt.verify(token, secret("AUTH_SECRET"), {
      algorithms: ["HS256"],
      issuer: issuer(),
      audience: audience(),
    });
    if (
      !Number.isInteger(claims.exp) ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      !["admin", "user"].includes(claims.role)
    )
      throw denied();
    req.actor = {
      user_id: claims.sub,
      role: claims.role,
      priority: claims.priority === 2 ? 2 : 1,
    };
    next();
  } catch {
    next(denied());
  }
}
function internal(req, res, next) {
  const actual = Buffer.from(req.get("Authorization") || "");
  const expected = Buffer.from("Bearer " + secret("INTERNAL_TOKEN"));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return next(denied());
  next();
}
function admin(req, res, next) {
  if (req.actor.role !== "admin")
    return next(new ApiError(403, "FORBIDDEN", "Admin access is required."));
  next();
}
// Local account file is generated on the developer's laptop. A team identity provider can issue the same JWT.
async function login(req, res) {
  only(req.body, ["username", "password"]);
  const { username, password } = req.body;
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    password.length > 128
  )
    throw denied();
  const accounts = JSON.parse(
    process.env.ACCOUNTS_JSON ||
      fs.readFileSync(process.env.ACCOUNTS_FILE, "utf8"),
  );
  const account = accounts.find((a) => a.user_id === username);
  const check = account || accounts[0];
  const actual = await scrypt(password, check.salt, 64);
  if (!timingSafeEqual(actual, Buffer.from(check.hash, "hex")) || !account)
    throw denied();
  const token = jwt.sign(
    { role: account.role, priority: account.priority },
    secret("AUTH_SECRET"),
    {
      algorithm: "HS256",
      subject: account.user_id,
      issuer: issuer(),
      audience: audience(),
      expiresIn: "1h",
    },
  );
  res.json({
    success: true,
    data: { access_token: token, token_type: "Bearer", expires_in: 3600 },
  });
}
module.exports = { user, admin, internal, login, secret };
