function clean(value, maxLength = 500) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

function logEvent(level, event, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event: clean(event, 100),
    ...fields
  };
  const output = JSON.stringify(record);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logEvent(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http_request", {
      correlationId: req.correlationId || "",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(elapsedMs),
      userSource: req.user && req.user.source ? req.user.source : "none"
    });
  });
  next();
}

module.exports = { logEvent, requestLogger };
