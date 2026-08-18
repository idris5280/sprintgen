const crypto = require("crypto");

function cleanIdentityPart(value, fallback = "") {
  const cleaned = String(value || "").trim();
  return cleaned || fallback;
}

function getUserFromRequest(req) {
  const production = process.env.NODE_ENV === "production";
  const principalId = cleanIdentityPart(req.get("x-ms-client-principal-id"));
  const principalName = cleanIdentityPart(req.get("x-ms-client-principal-name"));

  if (principalId) {
    return {
      id: principalId,
      name: principalName || "Scrum Studio user",
      source: "easy-auth"
    };
  }

  if (!production) {
    return {
      id: cleanIdentityPart(process.env.SCRUM_STUDIO_DEV_USER_ID, "local-dev"),
      name: cleanIdentityPart(process.env.SCRUM_STUDIO_DEV_USER_NAME, "Local developer"),
      source: "development"
    };
  }

  return null;
}

function attachRequestContext(req, res, next) {
  req.correlationId = cleanIdentityPart(req.get("x-correlation-id"), crypto.randomUUID());
  res.set("x-correlation-id", req.correlationId);
  next();
}

function requireApiUser(req, res, next) {
  const user = getUserFromRequest(req);

  if (!user) {
    res.status(401).json({
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in with your company account to use Scrum Studio."
      }
    });
    return;
  }

  req.user = user;
  req.correlationId = req.correlationId || crypto.randomUUID();
  next();
}

function requireSameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || process.env.NODE_ENV !== "production") {
    next();
    return;
  }

  const origin = cleanIdentityPart(req.get("origin"));
  const forwardedHost = cleanIdentityPart(req.get("x-forwarded-host"));
  const host = forwardedHost || cleanIdentityPart(req.get("host"));

  if (!origin || !host) {
    res.status(403).json({ error: { code: "ORIGIN_REQUIRED", message: "This request must come from Scrum Studio." } });
    return;
  }

  try {
    if (new URL(origin).host !== host) {
      throw new Error("Origin mismatch");
    }
  } catch (error) {
    res.status(403).json({ error: { code: "ORIGIN_REJECTED", message: "This request did not come from Scrum Studio." } });
    return;
  }

  next();
}

module.exports = {
  attachRequestContext,
  getUserFromRequest,
  requireApiUser,
  requireSameOrigin
};
