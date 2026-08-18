const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { logEvent, requestLogger } = require("./logger");
const { createConcurrencyGate, createRateLimiter, fetchWithTimeout } = require("./runtimeSafety");

const IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

const TRIVIA_CATEGORIES = new Map([
  ["general-knowledge", { id: 9, label: "General Knowledge" }],
  ["books", { id: 10, label: "Books" }],
  ["music", { id: 12, label: "Music" }],
  ["video-games", { id: 15, label: "Video Games" }],
  ["board-games", { id: 16, label: "Board Games" }],
  ["science-nature", { id: 17, label: "Science & Nature" }],
  ["computers", { id: 18, label: "Computers" }],
  ["mathematics", { id: 19, label: "Mathematics" }],
  ["mythology", { id: 20, label: "Mythology" }],
  ["sports", { id: 21, label: "Sports" }],
  ["geography", { id: 22, label: "Geography" }],
  ["history", { id: 23, label: "History" }],
  ["art", { id: 25, label: "Art" }],
  ["animals", { id: 27, label: "Animals" }],
  ["vehicles", { id: 28, label: "Vehicles" }]
]);
const triviaCache = new Map();
const TRIVIA_CACHE_MS = 30 * 60 * 1000;

function cleanString(value) {
  return String(value || "").trim();
}

function cleanList(value) {
  return (Array.isArray(value) ? value : [value])
    .map(cleanString)
    .filter(Boolean);
}

function shuffle(values) {
  const items = [...values];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

function decodeTriviaText(value) {
  try {
    return decodeURIComponent(cleanString(value));
  } catch {
    return cleanString(value);
  }
}

async function fetchTriviaCategory(slug) {
  const cached = triviaCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.questions;
  const category = TRIVIA_CATEGORIES.get(slug);
  let response;
  try {
    response = await fetchWithTimeout(`https://opentdb.com/api.php?amount=20&category=${category.id}&type=multiple&encode=url3986`, {}, 8000);
  } catch (error) {
    throw Object.assign(new Error("Trivia is temporarily unavailable."), { status: 504, code: "TRIVIA_TIMEOUT" });
  }
  if (!response.ok) throw Object.assign(new Error("Trivia is temporarily unavailable."), { status: 502, code: "TRIVIA_UNAVAILABLE" });
  const body = await response.json();
  const questions = (Array.isArray(body.results) ? body.results : []).map((item) => ({ question: decodeTriviaText(item.question), answer: decodeTriviaText(item.correct_answer), category: category.label })).filter((item) => item.question && item.answer);
  if (!questions.length) throw Object.assign(new Error("Trivia is temporarily unavailable."), { status: 502, code: "TRIVIA_UNAVAILABLE" });
  triviaCache.set(slug, { expiresAt: Date.now() + TRIVIA_CACHE_MS, questions });
  return questions;
}

function reviewSummary(review) {
  const result = review.result || {};
  const iteration = result.iteration || {};
  return {
    id: review.id,
    source: review.source,
    status: review.status || "draft",
    team: review.team || result.team || "",
    sprintName: review.sprintName || iteration.name || "Sprint Spotlight",
    updatedAt: review.updatedAt,
    createdAt: review.createdAt,
    generatedAt: review.generatedAt || ""
  };
}

function dataUrlToBuffer(value) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(cleanString(value));
  if (!match) return null;
  const contentType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  return { contentType, body: Buffer.from(match[2].replace(/\s/g, ""), "base64") };
}

function bufferToDataUrl(body, contentType) {
  return `data:${contentType};base64,${Buffer.from(body).toString("base64")}`;
}

function mediaRefIsSafe(value) {
  return /^media\/[a-f0-9-]+\.(?:png|jpg|webp|gif)$/i.test(cleanString(value));
}

async function externalizeMedia(store, userId, review) {
  const copy = structuredClone(review);
  const logo = copy.narrative && copy.narrative.teamLogo;

  async function externalize(target) {
    if (!target) return;
    if (target.mediaRef && !mediaRefIsSafe(target.mediaRef)) target.mediaRef = "";
    const decoded = dataUrlToBuffer(target.imageData);
    if (decoded && target.mediaRef) {
      target.imageData = "";
      return;
    }
    if (!decoded) {
      target.imageData = "";
      return;
    }
    if (decoded.body.length > 12 * 1024 * 1024) {
      const error = new Error("That image is larger than 12 MB. Choose a smaller PNG, JPG, GIF, or WebP image.");
      error.status = 413;
      error.code = "IMAGE_TOO_LARGE";
      throw error;
    }
    const extension = IMAGE_TYPES.get(decoded.contentType);
    const mediaRef = `media/${crypto.randomUUID()}.${extension}`;
    await store.writeArtifact(userId, copy.id, mediaRef, decoded.body, decoded.contentType);
    target.mediaRef = mediaRef;
    target.imageData = "";
  }

  await externalize(logo);
  for (const section of (copy.narrative && copy.narrative.sections) || []) {
    if (section.type === "screenshot") await externalize(section);
  }
  return copy;
}

async function hydrateMedia(store, userId, review) {
  const copy = structuredClone(review);

  async function hydrate(target) {
    if (!target || target.imageData || !mediaRefIsSafe(target.mediaRef)) return;
    try {
      const artifact = await store.readArtifact(userId, copy.id, target.mediaRef);
      target.imageData = bufferToDataUrl(artifact.body, artifact.contentType);
    } catch (error) {
      target.imageData = "";
    }
  }

  await hydrate(copy.narrative && copy.narrative.teamLogo);
  for (const section of (copy.narrative && copy.narrative.sections) || []) {
    if (section.type === "screenshot") await hydrate(section);
  }
  return copy;
}

function normalizeApiError(error) {
  const uploadTooLarge = error && error.code === "LIMIT_FILE_SIZE";
  const status = uploadTooLarge ? 413 : Number(error && (error.status || error.statusCode)) || 500;
  let message = cleanString(error && error.message) || "Scrum Studio could not complete that request.";
  let code = cleanString(error && error.code) || "REQUEST_FAILED";

  if (uploadTooLarge) {
    message = "That image is larger than 12 MB. Choose a smaller PNG, JPG, GIF, or WebP image.";
    code = "IMAGE_TOO_LARGE";
  }

  if (status === 401) {
    message = "Azure DevOps rejected Scrum Studio's managed-identity token. Ask an administrator to verify the identity configuration.";
    code = "ADO_AUTHENTICATION_FAILED";
  } else if (status === 403) {
    message = "Scrum Studio is signed in, but its managed identity cannot read that Azure DevOps resource. Ask an administrator to grant the required project and Analytics access.";
    code = "ADO_PERMISSION_DENIED";
  } else if (status === 412) {
    message = "This review changed in another browser window. Reload it before saving again.";
    code = "REVIEW_VERSION_CONFLICT";
  }

  return {
    status: status >= 400 && status <= 599 ? status : 500,
    error: {
      code,
      message,
      detail: cleanString(error && error.detail),
      correlationId: ""
    }
  };
}

function sendError(req, res, error) {
  const formatted = normalizeApiError(error);
  formatted.error.correlationId = req.correlationId || "";
  logEvent(formatted.status >= 500 ? "error" : "warn", "request_failed", {
    correlationId: formatted.error.correlationId,
    method: req.method,
    path: req.path,
    status: formatted.status,
    code: formatted.error.code,
    detail: formatted.error.detail || formatted.error.message
  });
  res.status(formatted.status).json(formatted);
}

function auditEvent(req, event, fields = {}) {
  logEvent("info", event, {
    correlationId: req.correlationId || "",
    userSource: req.user && req.user.source ? req.user.source : "none",
    ...fields
  });
}

function privateNoStore(req, res, next) {
  res.set("Cache-Control", "private, no-store");
  res.set("Pragma", "no-cache");
  next();
}

function securityHeaders(req, res, next) {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.set("Cross-Origin-Resource-Policy", "same-origin");
  res.set("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:"
  ].join("; "));
  const forwardedProto = cleanString(req.get("x-forwarded-proto")).split(",")[0].trim();
  if (process.env.NODE_ENV === "production" && forwardedProto === "https") {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

function createDefaultNarrative(deps, input = {}, result = {}) {
  const source = input || {};
  let sections = deps.normalizeNarrativeSections({ sections: source.sections || [] });
  const addDefaultMetrics = result.source === "ado" && !source.metricSectionsConfigured && !sections.some((section) => deps.isMetricSectionType(section.type));
  if (addDefaultMetrics) sections = [...deps.createDefaultMetricSections(), ...sections];
  const readiness = deps.normalizeEnvironmentReadiness(source);
  const teamLogo = deps.normalizeTeamLogo(source.teamLogo);
  return deps.stripSensitiveReviewKeys({
    summary: cleanString(source.summary) || deps.defaultSummaryText(result),
    openingTitle: cleanString(source.openingTitle) || "Opening Remarks",
    openingSubtitle: cleanString(source.openingSubtitle),
    sections,
    teamLogo,
    metricSectionsConfigured: Boolean(source.metricSectionsConfigured || addDefaultMetrics),
    environmentReadiness: readiness
  });
}

function prepareReviewForClient(deps, review) {
  if (!review || review.source !== "ado") return review;
  const narrative = createDefaultNarrative(deps, review.narrative || {}, review.result || {});
  const result = review.result || {};
  const workItems = result.workItems || { source: "", count: 0, items: [], warning: "" };
  const currentItems = deps.normalizeStoryItems(workItems.items);
  const nextWorkItems = review.nextWorkItems || { source: "", count: 0, items: [], warning: "" };
  const nextItems = deps.normalizeStoryItems(nextWorkItems.items);
  return {
    ...review,
    result: { ...result, workItems: { ...workItems, count: currentItems.length, items: currentItems } },
    nextWorkItems: { ...nextWorkItems, count: nextItems.length, items: nextItems },
    narrative
  };
}

function stampReview(review, user, existing = null) {
  const now = new Date().toISOString();
  return {
    ...review,
    schemaVersion: 2,
    ownerId: user.id,
    creatorName: existing && existing.creatorName ? existing.creatorName : user.name,
    createdAt: existing && existing.createdAt ? existing.createdAt : review.createdAt || now,
    updatedAt: now,
    status: review.status || (existing && existing.status) || "draft"
  };
}

function getIfMatch(req) {
  return cleanString(req.get("if-match"));
}

function requireIfMatch(req) {
  const etag = getIfMatch(req);
  if (!etag) {
    const error = new Error("Reload this review before changing it so Scrum Studio can verify you have the latest version.");
    error.status = 428;
    error.code = "REVIEW_VERSION_REQUIRED";
    throw error;
  }
  return etag;
}

function setEtag(res, etag) {
  if (etag) res.set("ETag", etag);
}

function parseWeatherLocation(value) {
  const raw = cleanString(value);
  const parts = raw.split(",").map(cleanString).filter(Boolean);
  return { raw, query: parts[0] || raw, region: parts[1] || "" };
}

function weatherCondition(code) {
  const value = Number(code);
  if (value === 0) return "Clear";
  if ([1, 2].includes(value)) return "Partly cloudy";
  if (value === 3) return "Overcast";
  if ([45, 48].includes(value)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(value)) return "Drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(value)) return "Snow";
  if ([95, 96, 99].includes(value)) return "Thunderstorm";
  return "Cloudy";
}

function registerCloudRoutes(app, deps) {
  const studioDist = path.join(deps.projectRoot, "apps", "studio", "dist");
  const studioIndex = path.join(studioDist, "index.html");
  const oglLitePath = path.join(deps.projectRoot, "public", "vendor", "ogl-lite.js");
  const revealDist = path.join(deps.projectRoot, "public", "vendor", "reveal");
  const revealAssets = new Map([
    ["reveal.js", { path: path.join(revealDist, "reveal.js"), type: "text/javascript" }],
    ["reveal.css", { path: path.join(revealDist, "reveal.css"), type: "text/css" }]
  ]);
  const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 1 },
    fileFilter(req, file, callback) {
      if (!IMAGE_TYPES.has(cleanString(file.mimetype).toLowerCase())) {
        callback(new Error("Choose a PNG, JPG, GIF, or WebP image."));
        return;
      }
      callback(null, true);
    }
  });
  const adoLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 60,
    code: "ADO_RATE_LIMITED",
    message: "Azure DevOps is receiving too many requests from this session. Wait a moment and try again."
  });
  const generationLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 8,
    code: "GENERATION_RATE_LIMITED",
    message: "Too many reports were generated in a short period. Wait a few minutes and try again."
  });
  const uploadLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 40,
    code: "UPLOAD_RATE_LIMITED",
    message: "Too many images were uploaded in a short period. Wait a few minutes and try again."
  });
  const pdfGate = createConcurrencyGate({ limit: 1, maxQueue: 3 });
  let readinessCache = { expiresAt: 0, value: null };

  async function readiness() {
    if (readinessCache.value && readinessCache.expiresAt > Date.now()) return readinessCache.value;
    const startedAt = Date.now();
    await deps.reviewStore.checkHealth();
    readinessCache = {
      expiresAt: Date.now() + 30000,
      value: { ok: true, storage: "ready", checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt }
    };
    return readinessCache.value;
  }

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(deps.attachRequestContext, requestLogger, securityHeaders);
  app.get("/assets/vendor/ogl-lite.js", (req, res) => {
    if (!fs.existsSync(oglLitePath)) {
      res.status(404).end();
      return;
    }
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("text/javascript").sendFile(oglLitePath);
  });
  app.get("/assets/vendor/reveal/:asset", (req, res) => {
    const asset = revealAssets.get(req.params.asset);
    if (!asset || !fs.existsSync(asset.path)) {
      res.status(404).end();
      return;
    }
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type(asset.type).sendFile(asset.path);
  });
  app.use("/assets", express.static(path.join(deps.projectRoot, "public"), { maxAge: "1h", immutable: false }));
  app.use(express.json({ limit: "30mb", type: ["application/json", "application/*+json"] }));

  app.get(["/health/live", "/api/health"], (req, res) => {
    res.json({ ok: true, app: "Scrum Studio", status: "live", time: new Date().toISOString() });
  });

  app.get("/health/ready", async (req, res) => {
    try {
      res.json(await readiness());
    } catch (error) {
      readinessCache = { expiresAt: 0, value: null };
      logEvent("error", "readiness_failed", { correlationId: req.correlationId || "", detail: cleanString(error.message) });
      res.status(503).json({ ok: false, storage: "unavailable", correlationId: req.correlationId || "" });
    }
  });

  app.use("/api", deps.requireApiUser, deps.requireSameOrigin, privateNoStore);
  app.use("/api/ado", adoLimiter);

  app.get("/api/me", (req, res) => {
    auditEvent(req, "authentication_succeeded");
    res.json({ user: req.user, ado: { org: deps.adoConfig.org, project: deps.adoConfig.project, auth: "managed-identity" } });
  });

  app.get("/api/ado/teams", async (req, res) => {
    try {
      const teams = await deps.listProjectTeams({ org: deps.adoConfig.org, project: deps.adoConfig.project });
      auditEvent(req, "ado_read_completed", { resource: "teams", count: Array.isArray(teams) ? teams.length : 0 });
      res.json(teams);
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.get("/api/ado/iterations", async (req, res) => {
    const team = cleanString(req.query.team);
    if (!team) return sendError(req, res, Object.assign(new Error("Choose a team before loading sprints."), { status: 400, code: "TEAM_REQUIRED" }));
    try {
      const iterations = await deps.listTeamIterations({ org: deps.adoConfig.org, project: deps.adoConfig.project, team });
      auditEvent(req, "ado_read_completed", { resource: "iterations", count: Array.isArray(iterations) ? iterations.length : 0 });
      res.json(iterations);
    } catch (error) {
      error.message = `${error.message} Team: ${team}.`;
      sendError(req, res, error);
    }
  });

  app.get("/api/ado/work-areas", async (req, res) => {
    const team = cleanString(req.query.team);
    if (!team) return sendError(req, res, Object.assign(new Error("Choose a team before loading work areas."), { status: 400, code: "TEAM_REQUIRED" }));
    try {
      const areas = await deps.listTeamAreaPaths({ org: deps.adoConfig.org, project: deps.adoConfig.project, team });
      auditEvent(req, "ado_read_completed", { resource: "work-areas", count: Array.isArray(areas) ? areas.length : 0 });
      res.json(areas);
    } catch (error) {
      error.message = `${error.message} Team: ${team}.`;
      sendError(req, res, error);
    }
  });

  app.post("/api/ado/review-draft", async (req, res) => {
    const team = cleanString(req.body.team);
    const sprint = cleanString(req.body.sprint);
    const areaPaths = cleanList(req.body.areaPaths);
    if (!team) return sendError(req, res, Object.assign(new Error("Choose a team."), { status: 400, code: "TEAM_REQUIRED" }));
    if (!sprint) return sendError(req, res, Object.assign(new Error("Choose a sprint."), { status: 400, code: "SPRINT_REQUIRED" }));
    if (!areaPaths.length) return sendError(req, res, Object.assign(new Error("Choose at least one work area."), { status: 400, code: "WORK_AREA_REQUIRED" }));

    try {
      const draft = await deps.buildAdoReviewDraft({ team, sprint, areaPaths });
      const existingId = cleanString(req.body.reviewId);
      const existingRecord = existingId ? await deps.reviewStore.readReview(req.user.id, existingId) : null;
      const existingEtag = existingRecord ? requireIfMatch(req) : "";
      const previous = existingRecord && existingRecord.value;
      const previousNarrative = previous
        ? deps.remapNarrativeStories(previous.narrative || {}, draft.currentItems, draft.nextWorkItems.items)
        : createDefaultNarrative(deps, req.body.narrative, draft.result);
      const review = stampReview(deps.createSavedReviewFromReport({
        generatedAt: new Date().toISOString().slice(0, 10),
        result: draft.result,
        nextIteration: draft.nextIteration,
        nextWorkItems: draft.nextWorkItems,
        narrative: previousNarrative
      }, previous), req.user, previous);
      const stored = await deps.reviewStore.writeReview(req.user.id, await externalizeMedia(deps.reviewStore, req.user.id, review), {
        etag: existingEtag
      });
      auditEvent(req, "review_persisted", { source: "ado", action: existingRecord ? "updated" : "created" });
      setEtag(res, stored.etag);
      res.status(existingRecord ? 200 : 201).json({ review: prepareReviewForClient(deps, await hydrateMedia(deps.reviewStore, req.user.id, stored.value)), etag: stored.etag });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.get("/api/reviews", async (req, res) => {
    try {
      const reviews = await deps.reviewStore.listReviews(req.user.id);
      res.json({ reviews: reviews.map(reviewSummary) });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.post("/api/reviews", async (req, res) => {
    try {
      const identity = req.body.identity || {};
      const draft = deps.buildManualReviewDraft({
        team: identity.team,
        sprint: identity.sprint,
        startDate: identity.startDate,
        finishDate: identity.finishDate
      });
      const narrative = createDefaultNarrative(deps, req.body.narrative, draft.result);
      const review = stampReview(deps.createSavedReviewFromReport({
        generatedAt: new Date().toISOString().slice(0, 10),
        result: draft.result,
        nextIteration: null,
        nextWorkItems: draft.nextWorkItems,
        narrative
      }), req.user);
      const stored = await deps.reviewStore.writeReview(req.user.id, await externalizeMedia(deps.reviewStore, req.user.id, review));
      auditEvent(req, "review_persisted", { source: "manual", action: "created" });
      setEtag(res, stored.etag);
      res.status(201).json({ review: await hydrateMedia(deps.reviewStore, req.user.id, stored.value), etag: stored.etag });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.get("/api/reviews/:id", async (req, res) => {
    try {
      const record = await deps.reviewStore.readReview(req.user.id, req.params.id);
      setEtag(res, record.etag);
      res.json({ review: prepareReviewForClient(deps, await hydrateMedia(deps.reviewStore, req.user.id, record.value)), etag: record.etag });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.put("/api/reviews/:id/presentation", async (req, res) => {
    try {
      const expectedEtag = requireIfMatch(req);
      const color = cleanString(req.body.color);
      if (!deps.isValidPresentationColor(color)) {
        const error = new Error("Choose a presentation color in #RRGGBB format.");
        error.status = 400;
        error.code = "INVALID_PRESENTATION_COLOR";
        throw error;
      }
      const record = await deps.reviewStore.readReview(req.user.id, req.params.id);
      const updated = stampReview({
        ...record.value,
        presentation: {
          ...(record.value.presentation || {}),
          color: deps.normalizePresentationColor(color)
        }
      }, req.user, record.value);
      const stored = await deps.reviewStore.writeReview(req.user.id, updated, { etag: expectedEtag });
      setEtag(res, stored.etag);
      res.json({
        review: prepareReviewForClient(deps, await hydrateMedia(deps.reviewStore, req.user.id, stored.value)),
        etag: stored.etag
      });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.put("/api/reviews/:id", async (req, res) => {
    try {
      const expectedEtag = requireIfMatch(req);
      const record = await deps.reviewStore.readReview(req.user.id, req.params.id);
      const current = record.value;
      const currentDraft = deps.buildDraftFromSavedReview(current);
      if (current.source === "manual") {
        const identity = req.body.identity || {};
        currentDraft.result.team = cleanString(identity.team || currentDraft.result.team);
        currentDraft.result.iteration = {
          ...currentDraft.result.iteration,
          name: cleanString(identity.sprint || currentDraft.result.iteration.name) || "Sprint Spotlight",
          path: cleanString(identity.sprint || currentDraft.result.iteration.path) || "Sprint Spotlight",
          startDate: cleanString(identity.startDate),
          finishDate: cleanString(identity.finishDate)
        };
      }
      let narrative = createDefaultNarrative(deps, req.body.narrative || current.narrative, currentDraft.result);
      if (current.source === "ado") {
        narrative = deps.remapNarrativeStories(narrative, currentDraft.currentItems, currentDraft.nextWorkItems.items);
      }
      const updated = stampReview(deps.createSavedReviewFromReport({
        ...current,
        generatedAt: current.generatedAt,
        result: currentDraft.result,
        nextIteration: currentDraft.nextIteration,
        nextWorkItems: currentDraft.nextWorkItems,
        narrative
      }, current), req.user, current);
      const stored = await deps.reviewStore.writeReview(req.user.id, await externalizeMedia(deps.reviewStore, req.user.id, updated), {
        etag: expectedEtag
      });
      auditEvent(req, "review_persisted", { source: current.source || "manual", action: "updated" });
      setEtag(res, stored.etag);
      res.json({ review: prepareReviewForClient(deps, await hydrateMedia(deps.reviewStore, req.user.id, stored.value)), etag: stored.etag });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.delete("/api/reviews/:id", async (req, res) => {
    try {
      await deps.reviewStore.deleteReview(req.user.id, req.params.id, { etag: requireIfMatch(req) });
      auditEvent(req, "review_deleted");
      res.status(204).end();
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.post("/api/reviews/:id/refresh", async (req, res) => {
    try {
      const expectedEtag = requireIfMatch(req);
      const record = await deps.reviewStore.readReview(req.user.id, req.params.id);
      const current = record.value;
      if (current.source !== "ado") {
        const error = new Error("This manual review has no Azure DevOps source. Use Add ADO data and choose a team, sprint, and work areas first.");
        error.status = 400;
        error.code = "ADO_SOURCE_REQUIRED";
        throw error;
      }
      const draft = await deps.buildAdoReviewDraft({ team: current.team, sprint: current.sprintPath, areaPaths: current.areaPaths });
      const narrative = deps.remapNarrativeStories(current.narrative || {}, draft.currentItems, draft.nextWorkItems.items);
      const refreshed = stampReview(deps.createSavedReviewFromReport({
        ...current,
        generatedAt: current.generatedAt,
        result: draft.result,
        nextIteration: draft.nextIteration,
        nextWorkItems: draft.nextWorkItems,
        narrative
      }, current), req.user, current);
      const stored = await deps.reviewStore.writeReview(req.user.id, refreshed, { etag: expectedEtag });
      auditEvent(req, "ado_review_refreshed", { areaCount: Array.isArray(current.areaPaths) ? current.areaPaths.length : 0 });
      setEtag(res, stored.etag);
      res.json({ review: prepareReviewForClient(deps, await hydrateMedia(deps.reviewStore, req.user.id, stored.value)), etag: stored.etag });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.post("/api/reviews/:id/generate", generationLimiter, async (req, res) => {
    let tempRoot = "";
    try {
      const expectedEtag = requireIfMatch(req);
      const record = await deps.reviewStore.readReview(req.user.id, req.params.id);
      const hydrated = await hydrateMedia(deps.reviewStore, req.user.id, record.value);
      const html = deps.renderHtmlReport(hydrated);
      await deps.reviewStore.writeArtifact(req.user.id, hydrated.id, "report.html", html, "text/html; charset=utf-8");
      const generated = stampReview({ ...record.value, generatedAt: new Date().toISOString().slice(0, 10), status: "ready" }, req.user, record.value);
      generated.pdf = { available: false, error: "" };
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scrum-studio-"));
      const htmlPath = path.join(tempRoot, "report.html");
      const pdfPath = path.join(tempRoot, "report.pdf");
      fs.writeFileSync(htmlPath, html, "utf8");
      try {
        await pdfGate.run(() => deps.generatePdf(htmlPath, pdfPath));
        await deps.reviewStore.writeArtifact(req.user.id, hydrated.id, "report.pdf", fs.readFileSync(pdfPath), "application/pdf");
        generated.pdf.available = true;
      } catch (pdfError) {
        generated.pdf.error = cleanString(pdfError.message).split(/\r?\n/)[0].slice(0, 220);
      }
      const stored = await deps.reviewStore.writeReview(req.user.id, generated, { etag: expectedEtag });
      auditEvent(req, "review_artifacts_generated", { pdfAvailable: generated.pdf.available });
      setEtag(res, stored.etag);
      res.json({
        review: reviewSummary(stored.value),
        etag: stored.etag,
        links: {
          report: `/reviews/${hydrated.id}/preview`,
          downloadHtml: `/reviews/${hydrated.id}/download-html`,
          color: `/reviews/${hydrated.id}/present?vibe=color&color=${deps.normalizePresentationColor(hydrated.presentation && hydrated.presentation.color).slice(1)}`,
          presentation: `/reviews/${hydrated.id}/present?vibe=blue`,
          floatingLines: `/reviews/${hydrated.id}/present?vibe=floating-lines`,
          iridescence: `/reviews/${hydrated.id}/present?vibe=iridescence`,
          pdf: generated.pdf.available ? `/reviews/${hydrated.id}/download-pdf` : ""
        }
      });
    } catch (error) {
      sendError(req, res, error);
    } finally {
      if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  app.post("/api/reviews/:id/media", uploadLimiter, mediaUpload.single("file"), async (req, res) => {
    try {
      await deps.reviewStore.readReview(req.user.id, req.params.id);
      if (!req.file) throw Object.assign(new Error("Choose an image to upload."), { status: 400, code: "IMAGE_REQUIRED" });
      const contentType = cleanString(req.file.mimetype).toLowerCase();
      const mediaRef = `media/${crypto.randomUUID()}.${IMAGE_TYPES.get(contentType)}`;
      await deps.reviewStore.writeArtifact(req.user.id, req.params.id, mediaRef, req.file.buffer, contentType);
      auditEvent(req, "review_media_uploaded", { contentType, bytes: req.file.size });
      res.status(201).json({ mediaRef, url: `/api/reviews/${req.params.id}/media/${path.basename(mediaRef)}` });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.get("/api/reviews/:id/media/:name", async (req, res) => {
    try {
      await deps.reviewStore.readReview(req.user.id, req.params.id);
      const artifact = await deps.reviewStore.readArtifact(req.user.id, req.params.id, `media/${path.basename(req.params.name)}`);
      res.type(artifact.contentType).send(artifact.body);
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.get("/api/settings/lobby", async (req, res) => {
    try {
      const record = await deps.reviewStore.readSettings(req.user.id);
      setEtag(res, record.etag);
      res.json({ settings: record.value, etag: record.etag });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.put("/api/settings/lobby", async (req, res) => {
    try {
      const value = deps.stripSensitiveReviewKeys(req.body.settings || {});
      const stored = await deps.reviewStore.writeSettings(req.user.id, value, { etag: getIfMatch(req) });
      setEtag(res, stored.etag);
      res.json({ settings: stored.value, etag: stored.etag });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  app.get("/api/weather", async (req, res) => {
    const location = parseWeatherLocation(req.query.location);
    if (!location.raw) return sendError(req, res, Object.assign(new Error("Enter a city to show weather."), { status: 400, code: "LOCATION_REQUIRED" }));
    try {
      const geoResponse = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location.query)}&count=10&language=en&format=json`, {}, 8000);
      if (!geoResponse.ok) throw Object.assign(new Error("Weather location search is unavailable."), { status: 502 });
      const geo = await geoResponse.json();
      const candidates = Array.isArray(geo.results) ? geo.results : [];
      const wanted = location.region.toLowerCase();
      const match = candidates.find((item) => wanted && cleanString(item.admin1).toLowerCase().includes(wanted)) || candidates.find((item) => item.country_code === "US") || candidates[0];
      if (!match) throw Object.assign(new Error("That weather location was not found."), { status: 404 });
      const forecastResponse = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(match.latitude)}&longitude=${encodeURIComponent(match.longitude)}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`, {}, 8000);
      if (!forecastResponse.ok) throw Object.assign(new Error("Weather forecast is unavailable."), { status: 502 });
      const forecast = await forecastResponse.json();
      const current = forecast.current || {};
      const daily = forecast.daily || {};
      const code = Number(current.weather_code);
      res.json({
        city: match.name || "",
        region: match.admin1 || match.country || "",
        tempF: Math.round(Number(current.temperature_2m) || 0),
        conditionText: weatherCondition(code),
        weatherCode: code,
        isDay: current.is_day === 1,
        highF: Math.round(Number(daily.temperature_2m_max && daily.temperature_2m_max[0]) || 0),
        lowF: Math.round(Number(daily.temperature_2m_min && daily.temperature_2m_min[0]) || 0)
      });
    } catch (error) {
      if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        error.status = 504;
        error.code = "WEATHER_TIMEOUT";
        error.message = "Weather is taking too long to respond. The lobby can continue without it.";
      }
      sendError(req, res, error);
    }
  });

  app.get("/api/trivia", async (req, res) => {
    const requested = [...new Set(cleanString(req.query.categories).split(",").map(cleanString).filter((value) => TRIVIA_CATEGORIES.has(value)))];
    if (!requested.length) return sendError(req, res, Object.assign(new Error("Choose at least one trivia topic."), { status: 400, code: "TRIVIA_CATEGORY_REQUIRED" }));
    const amount = Math.min(30, Math.max(5, Number(req.query.amount) || 20));
    const batchCategories = shuffle(requested).slice(0, 3);
    try {
      const batches = await Promise.allSettled(batchCategories.map(fetchTriviaCategory));
      const questions = shuffle(batches.filter((batch) => batch.status === "fulfilled").flatMap((batch) => batch.value)).slice(0, amount);
      if (!questions.length) throw Object.assign(new Error("Trivia is temporarily unavailable."), { status: 502, code: "TRIVIA_UNAVAILABLE" });
      res.json({ questions });
    } catch (error) {
      sendError(req, res, error);
    }
  });

  const artifactUser = [deps.requireApiUser, deps.requireSameOrigin, privateNoStore];
  app.get(["/reviews/:id/preview", "/ado-report/:id", "/preview/:id"], ...artifactUser, async (req, res) => {
    try {
      const record = await deps.reviewStore.readReview(req.user.id, req.params.id);
      res.type("html").send(deps.renderHtmlReport(await hydrateMedia(deps.reviewStore, req.user.id, record.value)));
    } catch (error) {
      sendError(req, res, error);
    }
  });
  app.get(["/reviews/:id/download-html", "/download-html/:id"], ...artifactUser, async (req, res) => {
    try {
      const record = await deps.reviewStore.readReview(req.user.id, req.params.id);
      const hydrated = await hydrateMedia(deps.reviewStore, req.user.id, record.value);
      res.set("Content-Disposition", `attachment; filename="${deps.getHtmlDownloadName(hydrated.sprintName)}"`);
      res.type("html").send(deps.renderHtmlReport(hydrated));
    } catch (error) {
      sendError(req, res, error);
    }
  });
  app.get("/reviews/:id/download-pdf", ...artifactUser, async (req, res) => {
    try {
      const artifact = await deps.reviewStore.readArtifact(req.user.id, req.params.id, "report.pdf");
      res.set("Content-Disposition", `attachment; filename="sprint-review.pdf"`);
      res.type("application/pdf").send(artifact.body);
    } catch (error) {
      sendError(req, res, error);
    }
  });
  app.get(["/reviews/:id/present", "/ado-present/:id", "/present/:id"], ...artifactUser, async (req, res) => {
    try {
      const record = await deps.reviewStore.readReview(req.user.id, req.params.id);
      res.type("html").send(deps.renderPresentation(
        await hydrateMedia(deps.reviewStore, req.user.id, record.value),
        { vibe: req.query.vibe, color: req.query.color }
      ));
    } catch (error) {
      sendError(req, res, error);
    }
  });

  if (fs.existsSync(studioDist)) app.use(express.static(studioDist, { index: false, maxAge: "1h" }));
  const spaRoutes = ["/", "/lobby", "/lobby/run", "/ado-admin", "/reviews", "/reviews/:id", "/reviews/:id/edit"];
  app.get(spaRoutes, deps.requireApiUser, (req, res) => {
    if (!fs.existsSync(studioIndex)) {
      res.status(503).type("text").send("Scrum Studio has not been built. Run npm run build:studio, then restart the server.");
      return;
    }
    res.sendFile(studioIndex);
  });

  app.use((error, req, res, next) => {
    if (req.path.startsWith("/api/")) {
      sendError(req, res, error);
      return;
    }
    next(error);
  });
}

module.exports = {
  externalizeMedia,
  hydrateMedia,
  normalizeApiError,
  registerCloudRoutes
};
