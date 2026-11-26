
const jwt = require("jsonwebtoken");
const { createPublicKey } = require("node:crypto");

let cachedKeys = [];
let cacheExpires = 0;

// Retrieve Cognito public signing keys
async function getSigningKey(kid) {
  if (Date.now() >= cacheExpires) {
    const response = await fetch(process.env.COGNITO_JWKS_URL, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });

    if (!response.ok) {
      throw new Error("Unable to retrieve Cognito public keys");
    }

    const data = await response.json();

    if (!Array.isArray(data.keys)) {
      throw new Error("Invalid Cognito JWKS");
    }

    cachedKeys = data.keys;
    cacheExpires = Date.now() + 5 * 60 * 1000;
  }

  const key = cachedKeys.find(
    (k) =>
      k.kid === kid &&
      k.kty === "RSA" &&
      k.alg === "RS256" &&
      k.use === "sig",
  );

  if (!key) {
    throw new Error("Signing key not found");
  }

  return createPublicKey({
    key,
    format: "jwk",
  });
}

// Verify Cognito access token
async function verifyAccessToken(token) {
  if (
    !process.env.COGNITO_ISSUER ||
    !process.env.COGNITO_CLIENT_ID ||
    !process.env.COGNITO_JWKS_URL
  ) {
    throw new Error("Missing Cognito configuration");
  }

  const decoded = jwt.decode(token, {
    complete: true,
  });

  if (
    !decoded ||
    decoded.header.alg !== "RS256" ||
    typeof decoded.header.kid !== "string"
  ) {
    throw new Error("Invalid token");
  }

  const publicKey = await getSigningKey(decoded.header.kid);

  const claims = jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: process.env.COGNITO_ISSUER,
  });

  if (
    claims.token_use !== "access" ||
    claims.client_id !== process.env.COGNITO_CLIENT_ID ||
    !Number.isInteger(claims.exp) ||
    typeof claims.sub !== "string" ||
    !claims.sub
  ) {
    throw new Error("Invalid token claims");
  }

  return claims;
}

module.exports = { verifyAccessToken };
