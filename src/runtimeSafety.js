const DEFAULT_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  return fetch(url, { ...options, signal });
}

function createRateLimiter({ windowMs, max, code, message }) {
  const buckets = new Map();
  let lastCleanup = 0;

  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (now - lastCleanup > windowMs) {
      lastCleanup = now;
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    const identity = req.user && req.user.id ? req.user.id : req.ip || "anonymous";
    const key = `${identity}:${code}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    res.set("RateLimit-Limit", String(max));
    res.set("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.set("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count <= max) {
      next();
      return;
    }

    res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    res.status(429).json({
      error: {
        code,
        message,
        correlationId: req.correlationId || ""
      }
    });
  };
}

function createConcurrencyGate({ limit = 1, maxQueue = 3 } = {}) {
  let active = 0;
  const waiting = [];

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  async function run(operation) {
    if (active >= limit) {
      if (waiting.length >= maxQueue) {
        const error = new Error("PDF generation is busy. The HTML report is still available; try the PDF again shortly.");
        error.status = 429;
        error.code = "PDF_GENERATION_BUSY";
        throw error;
      }
      await new Promise((resolve) => waiting.push(resolve));
    }

    active += 1;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  return { run, stats: () => ({ active, queued: waiting.length }) };
}

function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  const required = [
    "AZURE_CLIENT_ID",
    "ADO_ORG",
    "ADO_PROJECT",
    "AZURE_STORAGE_ACCOUNT_URL",
    "AZURE_STORAGE_CONTAINER",
    "APPLICATIONINSIGHTS_CONNECTION_STRING"
  ];
  const missing = required.filter((name) => !String(env[name] || "").trim());
  if (missing.length) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
}

module.exports = {
  createConcurrencyGate,
  createRateLimiter,
  fetchWithTimeout,
  validateProductionConfig
};
