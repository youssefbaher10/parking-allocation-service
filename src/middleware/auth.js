
const { timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const { ApiError } = require("../services/errors");
const { only } = require("../services/rules");
const { verifyAccessToken } = require("./cognito");

const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

let cognitoClient;

const denied = () =>
  new ApiError(
    401,
    "UNAUTHORIZED",
    "Valid credentials are required."
  );

// Validate secret configuration
function secret(name) {
  const value = process.env[name];

  if (!value || Buffer.byteLength(value) < 32) {
    throw new Error("Set a strong " + name + " before starting.");
  }

  return value;
}

// Retrieve user identity, role and parking priority
function cognitoActor(claims) {
  const groups = claims["cognito:groups"];

  if (!Array.isArray(groups)) {
    throw denied();
  }

  const roles = groups.filter(
    (group) => ["admin", "user"].includes(group)
  );

  if (roles.length !== 1) {
    throw denied();
  }

  // Read identity mapping from Secrets Manager environment
  // or from the local Cognito users file
  const accounts = JSON.parse(
    process.env.COGNITO_USERS_JSON?.trim() ||
    fs.readFileSync(process.env.COGNITO_USERS_FILE, "utf8")
  );

  if (!Object.hasOwn(accounts, claims.sub)) {
    throw denied();
  }

  const account = accounts[claims.sub];

  if (
    !account ||
    typeof account.user_id !== "string" ||
    !account.user_id ||
    ![1, 2].includes(account.priority)
  ) {
    throw denied();
  }

  return {
    user_id: account.user_id,
    role: roles[0],
    priority: account.priority,
  };
}

// Authenticate protected API requests using Cognito
async function user(req, res, next) {
  try {
    const authorization = req.get("Authorization") || "";

    if (!authorization.startsWith("Bearer ")) {
      throw denied();
    }

    const token = authorization.slice(7);

    const claims = await verifyAccessToken(token);

    req.actor = cognitoActor(claims);

    next();

  } catch {
    next(denied());
  }
}

// Authenticate internal microservice requests
function internal(req, res, next) {
  const actual = Buffer.from(req.get("Authorization") || "");

  const expected = Buffer.from(
    "Bearer " + secret("INTERNAL_TOKEN")
  );

  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return next(denied());
  }

  next();
}

// Restrict administrator operations
function admin(req, res, next) {
  if (req.actor.role !== "admin") {
    return next(
      new ApiError(
        403,
        "FORBIDDEN",
        "Admin access is required."
      )
    );
  }

  next();
}

// Authenticate users through Cognito
async function login(req, res) {
  only(req.body, ["username", "password"]);

  const { username, password } = req.body;

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username ||
    !password ||
    password.length > 128
  ) {
    throw denied();
  }

  // Initialize Cognito SDK client
  if (!cognitoClient) {
    cognitoClient = new CognitoIdentityProviderClient({
      region: process.env.COGNITO_REGION,
      endpoint: process.env.COGNITO_ENDPOINT,
    });
  }

  let response;

  // Authenticate credentials using Cognito
  try {
    response = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: process.env.COGNITO_CLIENT_ID,
        AuthParameters: {
          USERNAME: username,
          PASSWORD: password,
        },
      }),
      {
        abortSignal: AbortSignal.timeout(5000),
      }
    );

  } catch (error) {
    if (
      [
        "NotAuthorizedException",
        "UserNotFoundException",
        "UserNotConfirmedException",
        "PasswordResetRequiredException",
      ].includes(error.name)
    ) {
      throw denied();
    }

    throw new ApiError(
      503,
      "AUTH_UNAVAILABLE",
      "Authentication service is temporarily unavailable."
    );
  }

  const result = response.AuthenticationResult;

  if (!result?.AccessToken) {
    throw denied();
  }

  // Verify Cognito token and registered user identity
  try {
    const claims = await verifyAccessToken(result.AccessToken);

    cognitoActor(claims);

  } catch {
    throw denied();
  }

  // Prevent caching sensitive authentication responses
  res.set("Cache-Control", "no-store");

  return res.json({
    success: true,
    data: {
      access_token: result.AccessToken,
      token_type: "Bearer",
      expires_in: result.ExpiresIn,
    },
  });
}

module.exports = {
  user,
  admin,
  internal,
  login,
  secret,
};
