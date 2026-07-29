const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { renderBrandRail } = require("./brandRail");
const { exportPdf, generateReport, normalizePresentationVibe, projectRoot, renderPresentationHtml } = require("./reportGenerator");
const {
  fetchAnalyticsMetadata,
  getAdoConfig,
  listProjectTeams,
  listTeamAreaPaths,
  listTeamIterations,
  queryIterationSnapshotRows,
  queryIterationWorkItems,
  resolveIterationInput,
  summarizeBurndownRows
} = require("./adoClient");
const { buildAdoMetrics, findNextIteration, findVelocityIterations, normalizeWorkItem } = require("./adoMetrics");

const app = express();
const port = process.env.PORT || 3000;
const defaultDataRoot = process.env.APPDATA
  ? path.join(process.env.APPDATA, "ScrumStudio")
  : path.join(projectRoot, "runtime", "ScrumStudio");
const fallbackDataRoot = path.join(os.tmpdir(), "ScrumStudio");
let runtimeDir = process.env.SCRUM_STUDIO_RUNTIME_DIR
  ? path.resolve(process.env.SCRUM_STUDIO_RUNTIME_DIR)
  : path.join(defaultDataRoot, "runtime");
let jobsDir = path.join(runtimeDir, "jobs");
let savedReviewsDir = process.env.SCRUM_STUDIO_DATA_DIR
  ? path.resolve(process.env.SCRUM_STUDIO_DATA_DIR)
  : path.join(defaultDataRoot, "reviews");
const sampleWorkbookPath = path.join(projectRoot, "input", "sample-sprint-demo.xlsx");
const lobbyDistDir = path.join(projectRoot, "apps", "lobby", "dist");
const lobbyIndexPath = path.join(lobbyDistDir, "index.html");
const maxUploadBytes = 8 * 1024 * 1024;
const maxScreenshotBytes = 5 * 1024 * 1024;
const maxJobAgeMs = 6 * 60 * 60 * 1000;
const adoConfig = getAdoConfig();
const defaultAdoTeam = process.env.ADO_DEFAULT_TEAM || "(Team7) - Sales Value Stream - Vital Signs";
const adoSessionCookieName = "sprintgen_ado_admin";
const adoSessionTtlMs = 4 * 60 * 60 * 1000;
const adoSessions = new Map();

function ensureRuntimeDirs() {
  try {
    fs.mkdirSync(jobsDir, { recursive: true });
  } catch (error) {
    runtimeDir = path.join(fallbackDataRoot, "runtime");
    jobsDir = path.join(runtimeDir, "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    console.warn(`Scrum Studio could not write temp jobs to the preferred folder. Using ${jobsDir}.`);
  }

  try {
    fs.mkdirSync(savedReviewsDir, { recursive: true });
  } catch (error) {
    savedReviewsDir = path.join(fallbackDataRoot, "reviews");
    fs.mkdirSync(savedReviewsDir, { recursive: true });
    console.warn(`Scrum Studio could not write saved reviews to the preferred folder. Using ${savedReviewsDir}.`);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function sanitizeDownloadName(value) {
  const clean = String(value || "sprint-demo")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return clean || "sprint-demo";
}

function getHtmlDownloadName(value) {
  return `${sanitizeDownloadName(value || "sprint-review")}.html`;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";

  return header.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");

    if (index === -1) {
      return cookies;
    }

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (name) {
      cookies[name] = decodeURIComponent(value);
    }

    return cookies;
  }, {});
}

function createAdoSession(res, pat) {
  const sessionId = crypto.randomUUID();

  adoSessions.set(sessionId, {
    pat,
    createdAt: Date.now(),
    expiresAt: Date.now() + adoSessionTtlMs
  });

  res.cookie(adoSessionCookieName, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: adoSessionTtlMs
  });

  return sessionId;
}

function getAdoSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[adoSessionCookieName];

  if (!sessionId || !adoSessions.has(sessionId)) {
    return null;
  }

  const session = adoSessions.get(sessionId);

  if (!session || session.expiresAt < Date.now()) {
    adoSessions.delete(sessionId);
    return null;
  }

  session.expiresAt = Date.now() + adoSessionTtlMs;
  return {
    id: sessionId,
    ...session
  };
}

function clearAdoSession(req, res) {
  const cookies = parseCookies(req);
  const sessionId = cookies[adoSessionCookieName];

  if (sessionId) {
    adoSessions.delete(sessionId);
  }

  res.clearCookie(adoSessionCookieName);
}

function cleanupAdoSessions() {
  const now = Date.now();

  for (const [sessionId, session] of adoSessions.entries()) {
    if (!session || session.expiresAt < now) {
      adoSessions.delete(sessionId);
    }
  }
}

function createJobId(req, res, next) {
  req.jobId = crypto.randomUUID();
  next();
}

function isUuid(value) {
  return /^[a-f0-9-]{36}$/i.test(String(value || ""));
}

function getJobDir(jobId) {
  if (!isUuid(jobId)) {
    throw new Error("Invalid job id.");
  }

  const jobDir = path.join(jobsDir, jobId);
  const resolvedJobsDir = path.resolve(jobsDir);
  const resolvedJobDir = path.resolve(jobDir);

  if (!resolvedJobDir.startsWith(resolvedJobsDir)) {
    throw new Error("Invalid job path.");
  }

  return jobDir;
}

function getJobPaths(jobId) {
  const jobDir = getJobDir(jobId);

  return {
    jobDir,
    uploadPath: path.join(jobDir, "upload.xlsx"),
    htmlPath: path.join(jobDir, "sprint-demo.html"),
    pdfPath: path.join(jobDir, "sprint-demo.pdf"),
    adoDataPath: path.join(jobDir, "ado-report.json"),
    metaPath: path.join(jobDir, "metadata.json")
  };
}

function getSavedReviewDir(reviewId) {
  if (!isUuid(reviewId)) {
    throw new Error("Invalid review id.");
  }

  const reviewDir = path.join(savedReviewsDir, reviewId);
  const resolvedReviewsDir = path.resolve(savedReviewsDir);
  const resolvedReviewDir = path.resolve(reviewDir);

  if (!resolvedReviewDir.startsWith(resolvedReviewsDir)) {
    throw new Error("Invalid review path.");
  }

  return reviewDir;
}

function getSavedReviewPaths(reviewId) {
  const reviewDir = getSavedReviewDir(reviewId);

  return {
    reviewDir,
    dataPath: path.join(reviewDir, "review.json"),
    htmlPath: path.join(reviewDir, "sprint-review.html"),
    pdfPath: path.join(reviewDir, "sprint-review.pdf")
  };
}

function removeJob(jobId) {
  if (!jobId) {
    return;
  }

  const paths = getJobPaths(jobId);
  fs.rmSync(paths.jobDir, { recursive: true, force: true });
}

function cleanupOldJobs() {
  ensureRuntimeDirs();

  for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const jobDir = path.join(jobsDir, entry.name);
    const age = Date.now() - fs.statSync(jobDir).mtimeMs;

    if (age > maxJobAgeMs) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }
}

function stripSensitiveReviewKeys(value) {
  if (Array.isArray(value)) {
    return value.map(stripSensitiveReviewKeys);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const blockedKeys = new Set([
    "authorization",
    "auth",
    "cookie",
    "password",
    "pat",
    "personalaccesstoken",
    "session",
    "token"
  ]);

  return Object.entries(value).reduce((clean, [key, entry]) => {
    const normalizedKey = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");

    if (blockedKeys.has(normalizedKey)) {
      return clean;
    }

    clean[key] = stripSensitiveReviewKeys(entry);
    return clean;
  }, {});
}

function createSavedReviewFromReport(report, existingReview = null) {
  const result = report.result || {};
  const iteration = result.iteration || {};
  const now = new Date().toISOString();
  const id = (existingReview && existingReview.id) || crypto.randomUUID();

  return stripSensitiveReviewKeys({
    id,
    createdAt: (existingReview && existingReview.createdAt) || now,
    updatedAt: now,
    generatedAt: report.generatedAt || now.slice(0, 10),
    team: result.team || "",
    sprintName: iteration.name || getSprintLabel(iteration.path),
    sprintPath: iteration.path || "",
    areaPath: primaryAreaPath(result.areaPaths, result.areaPath),
    areaPaths: normalizeAreaPathList(result.areaPaths, result.areaPath),
    dateRange: {
      startDate: iteration.startDate || "",
      finishDate: iteration.finishDate || ""
    },
    result: report.result || null,
    nextIteration: report.nextIteration || null,
    nextWorkItems: report.nextWorkItems || {
      source: "Not saved",
      count: 0,
      items: [],
      warning: ""
    },
    narrative: report.narrative || {},
    pdf: report.pdf || {
      available: false,
      error: ""
    },
    generation: {
      source: "Azure DevOps snapshot",
      app: "Scrum Studio"
    }
  });
}

function readSavedReview(reviewId) {
  const paths = getSavedReviewPaths(reviewId);

  if (!fs.existsSync(paths.dataPath)) {
    throw new Error("That saved review was not found.");
  }

  return JSON.parse(fs.readFileSync(paths.dataPath, "utf8").replace(/^\uFEFF/, ""));
}

function writeSavedReviewData(review) {
  const paths = getSavedReviewPaths(review.id);
  const cleanReview = stripSensitiveReviewKeys(review);

  fs.mkdirSync(paths.reviewDir, { recursive: true });
  fs.writeFileSync(paths.dataPath, JSON.stringify(cleanReview, null, 2), "utf8");
  return cleanReview;
}

async function writeSavedReviewArtifacts(review) {
  const paths = getSavedReviewPaths(review.id);
  const cleanReview = stripSensitiveReviewKeys(review);

  fs.mkdirSync(paths.reviewDir, { recursive: true });
  fs.writeFileSync(paths.htmlPath, renderAdoReportHtml(cleanReview), "utf8");
  cleanReview.pdf = {
    available: false,
    error: ""
  };

  try {
    await exportPdf(paths.htmlPath, paths.pdfPath);
    cleanReview.pdf = {
      available: true,
      error: ""
    };
  } catch (pdfError) {
    cleanReview.pdf = {
      available: false,
      error: summarizePdfExportError(pdfError)
    };
  }

  return writeSavedReviewData(cleanReview);
}

function listSavedReviews() {
  ensureRuntimeDirs();

  return fs
    .readdirSync(savedReviewsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isUuid(entry.name))
    .map((entry) => {
      try {
        return readSavedReview(entry.name);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
}

function buildDraftFromSavedReview(review) {
  const savedResult = review.result || {};
  const savedAreaPaths = getSavedReviewAreaPaths(review, savedResult);
  const result = {
    ...savedResult,
    areaPath: primaryAreaPath(savedAreaPaths),
    areaPaths: savedAreaPaths,
    areaPathLabel: areaPathDisplay(savedAreaPaths)
  };
  const currentItems = normalizeStoryItems(result.workItems && result.workItems.items);
  const completedItems =
    result.metrics && result.metrics.items ? normalizeStoryItems(result.metrics.items.completed) : [];
  const nextWorkItems = review.nextWorkItems || {
    source: "Saved snapshot",
    count: 0,
    items: [],
    warning: ""
  };
  const nextItems = normalizeStoryItems(nextWorkItems.items);

  return {
    result,
    currentItems,
    completedItems,
    nextIteration: review.nextIteration || null,
    nextWorkItems: {
      ...nextWorkItems,
      items: nextItems,
      count: nextItems.length
    }
  };
}

function storyIdsFromSelection(stories) {
  return (stories || []).map((story) => story && story.id).filter((id) => id !== undefined && id !== null);
}

function remapNarrativeStories(narrative, currentItems, nextItems) {
  const currentNarrative = narrative || {};
  const sections = normalizeNarrativeSections(currentNarrative).map((section) =>
    section.type === "delivery"
      ? {
          ...section,
          stories: selectStoriesById(currentItems, storyIdsFromSelection(section.stories))
        }
      : section.type === "next_steps"
        ? {
            ...section,
            stories: selectStoriesById(nextItems, storyIdsFromSelection(section.stories))
          }
      : section
  );
  const readiness = normalizeEnvironmentReadiness(currentNarrative);
  const environmentReadiness = {
    training: {
      ...readiness.training,
      stories: selectStoriesById(currentItems, storyIdsFromSelection(readiness.training.stories))
    },
    uat: {
      ...readiness.uat,
      stories: selectStoriesById(currentItems, storyIdsFromSelection(readiness.uat.stories))
    }
  };

  return {
    ...currentNarrative,
    sections,
    updates: deliveryUpdatesFromSections(sections),
    demo: demoFromSections(sections),
    nextSteps: nextStepsFromSections(sections),
    environmentReadiness
  };
}

function getSavedReviewDownloadName(review) {
  const result = (review && review.result) || {};
  const iteration = result.iteration || {};
  return getHtmlDownloadName(iteration.name || review.sprintName || "sprint-review");
}

function formatSavedTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderPage({ title, bodyClass = "", content }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/styles.css?v=6">
  <script src="/assets/review-builder.js?v=2" defer></script>
</head>
<body class="${escapeHtml(bodyClass)}">
  <div class="confetti-sprinkle" aria-hidden="true"></div>
  <main class="app-shell">
    ${content}
  </main>
</body>
</html>`;
}

function renderHomePage() {
  return renderPage({
    title: "Scrum Studio",
    bodyClass: "studio-page",
    content: `
      <section class="studio-home" aria-labelledby="studio-main-title">
        <header class="studio-header" aria-label="Scrum Studio">
          <a class="studio-brand" href="/" aria-label="Scrum Studio home">
            <span class="studio-brand-mark" aria-hidden="true"></span>
            <span>Scrum Studio</span>
          </a>
        </header>

        <div class="studio-intro">
          <p class="studio-eyebrow">Workspace picker</p>
          <h1 id="studio-main-title">What are you working on today?</h1>
          <p>Choose the workspace that fits the scrum work in front of you.</p>
        </div>

        <div class="studio-tool-grid" aria-label="Scrum Studio tools">
          <a class="studio-tool-card studio-tool-card-lobby" href="/lobby" aria-labelledby="studio-lobby-title" aria-describedby="studio-lobby-description">
            <span class="studio-tool-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" role="img">
                <rect x="3" y="4" width="18" height="13" rx="2.5"></rect>
                <path d="M8 21h8"></path>
                <path d="M12 17v4"></path>
                <path d="M8.5 10.5h7"></path>
              </svg>
            </span>
            <div class="studio-tool-copy">
              <span class="studio-tool-label">Team waiting room</span>
              <h2 id="studio-lobby-title">Lobby</h2>
              <p id="studio-lobby-description">Join or host the screen-shared waiting room with countdown, prompts, weather, and music for any scrum ceremony.</p>
            </div>
            <span class="studio-tool-button">Open Lobby</span>
          </a>

          <a class="studio-tool-card studio-tool-card-build" href="/ado-admin" aria-labelledby="studio-build-title" aria-describedby="studio-build-description">
            <span class="studio-tool-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" role="img">
                <path d="M7 3h7l4 4v14H7z"></path>
                <path d="M14 3v5h5"></path>
                <path d="M10 12h6"></path>
                <path d="M10 16h6"></path>
                <path d="M10 20h3"></path>
              </svg>
            </span>
            <div class="studio-tool-copy">
              <span class="studio-tool-label">Sprint reviews</span>
              <h2 id="studio-build-title">Review Builder</h2>
              <p id="studio-build-description">Create and prepare sprint review materials from ADO, then generate the HTML report and presentation mode.</p>
            </div>
            <span class="studio-tool-button">Open Review Builder</span>
          </a>
        </div>
      </section>
    `
  });
}

function renderResultPage({ jobId, data }) {
  const warningHtml =
    data.warnings.length > 0
      ? `<div class="alert alert-warn"><strong>A few sections took the day off:</strong><ul>${data.warnings
          .map((warning) => `<li>${escapeHtml(warning)}</li>`)
          .join("")}</ul></div>`
      : `<div class="alert alert-good"><strong>Workbook looks great.</strong> All core sections have content.</div>`;

  return renderPage({
    title: "SprintGen - Report Ready",
    bodyClass: "result-page",
    content: `
      <section class="result-card">
        <div class="success-orb">yay</div>
        <div class="eyebrow">Report ready</div>
        <h1>${escapeHtml(data.basics.SprintName)} is ready to show off.</h1>
        <p class="lede">Your sprint review is packaged into a polished standalone HTML file for sharing or screen viewing.</p>
        ${warningHtml}
        <div class="result-actions">
          <a class="primary-button" href="/download-html/${encodeURIComponent(jobId)}">Download HTML</a>
          <a class="secondary-button strong" href="/preview/${encodeURIComponent(jobId)}" target="_blank" rel="noreferrer">Open HTML report</a>
          <a class="ghost-button" href="/">Generate another report</a>
        </div>
        <div class="present-launch">
          <span>Presentation Mode</span>
          <p>Temporary browser links for same-day screen sharing. The downloaded HTML is the durable report artifact.</p>
          <strong>Select a mode:</strong>
          <div class="present-launch-actions">
            <a class="secondary-button" href="/present/${encodeURIComponent(jobId)}?vibe=light" target="_blank" rel="noreferrer">Light</a>
            <a class="secondary-button" href="/present/${encodeURIComponent(jobId)}?vibe=blue" target="_blank" rel="noreferrer">Blue</a>
            <a class="secondary-button strong" href="/present/${encodeURIComponent(jobId)}?vibe=prismatic" target="_blank" rel="noreferrer">Prismatic</a>
          </div>
        </div>
        <div class="mini-summary">
          <div><span>Team</span><strong>${escapeHtml(data.basics.TeamName)}</strong></div>
          <div><span>Dates</span><strong>${escapeHtml(data.basics.DateRange)}</strong></div>
          <div><span>Target</span><strong>${escapeHtml(data.basics.TargetRollout)}</strong></div>
        </div>
      </section>
    `
  });
}

function formatDateOnly(value) {
  if (!value) {
    return "Not available";
  }

  const raw = String(value);
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (isoMatch) {
    return `${Number(isoMatch[2])}/${Number(isoMatch[3])}/${isoMatch[1].slice(2)}`;
  }

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(2)}`;
}

function formatNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "0";
  }

  return number.toLocaleString("en-US", {
    maximumFractionDigits: 1
  });
}

function normalizeStatusCode(status) {
  const number = Number(status);
  return number >= 400 && number <= 599 ? number : 500;
}

function isContributorFieldWarning(warning) {
  return /AssignedTo|Assigned To|Contributor names|contributor names|could not fill contributor/i.test(String(warning || ""));
}

function filterContributorWarnings(warnings, contributors) {
  const hasContributors = Array.isArray(contributors) && contributors.length > 0;

  return (warnings || []).filter((warning) => warning && (!hasContributors || !isContributorFieldWarning(warning)));
}

function formatAdoError(error) {
  const status = normalizeStatusCode(error.status);
  let message = error.message || "Azure DevOps could not complete the feasibility test.";

  if (status === 401) {
    message = "Azure DevOps rejected the PAT. Confirm it is copied correctly, active, and scoped to esiappdev.";
  } else if (status === 403) {
    message = "Azure DevOps accepted the request but blocked access. The PAT user likely needs read access to work items, teams, or Analytics.";
  } else if (status === 404) {
    message = error.message || "Azure DevOps could not find that team, sprint, project, or Analytics resource.";
  }

  return {
    status,
    message,
    detail: error.detail || "",
    code: error.code || "ADO_ERROR"
  };
}

function summarizePdfExportError(error) {
  const message = String((error && error.message) || error || "PDF export failed.");

  if (message.includes("spawn EPERM")) {
    return "PDF export was blocked because Chromium could not launch in this local environment. The HTML report and Presentation Mode were still generated.";
  }

  return message.split(/\r?\n/)[0].slice(0, 220);
}

function renderAdoRows(rows) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-state">No grouped burndown rows came back for this sprint yet.</div>`;
  }

  return `
    <div class="table-wrap">
      <table class="ado-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>State</th>
            <th>Count</th>
            <th>Story Points</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>${escapeHtml(formatDateOnly(row.DateValue))}</td>
                  <td>${escapeHtml(row.State || "Unknown")}</td>
                  <td>${escapeHtml(formatNumber(row.Count))}</td>
                  <td>${escapeHtml(formatNumber(row.TotalStoryPoints))}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAdoWorkItems(items) {
  if (!items || items.length === 0) {
    return "";
  }

  return `
    <div class="ado-work-items">
      ${items
        .slice(0, 6)
        .map((item) => {
          const fields = item.fields || item;
          const id = fields["System.Id"] || item.WorkItemId || item.id || "";
          const title = fields["System.Title"] || item.Title || "Untitled work item";
          const state = fields["System.State"] || item.State || "Unknown";
          const type = fields["System.WorkItemType"] || item.WorkItemType || "Work Item";
          const areaPath = fields["System.AreaPath"] || item.AreaPath || item.areaPath || "";

          return `
            <div>
              <span>${escapeHtml(type)} ${escapeHtml(id)}</span>
              <strong>${escapeHtml(title)}</strong>
              <small>${escapeHtml([state, areaPath ? areaPathLeaf(areaPath) : ""].filter(Boolean).join(" - "))}</small>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function getMetricAnimationParts(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^([^0-9-]*)(-?\d+(?:\.\d+)?)(.*)$/);

  if (!match) {
    return null;
  }

  const target = Number(match[2]);

  if (!Number.isFinite(target)) {
    return null;
  }

  const decimalPart = match[2].split(".")[1] || "";

  return {
    prefix: match[1] || "",
    target,
    suffix: match[3] || "",
    decimals: decimalPart.length
  };
}

function renderMetricAnimationAttributes(value) {
  const parts = getMetricAnimationParts(value);

  if (!parts) {
    return "";
  }

  return [
    `data-count-target="${escapeHtml(parts.target)}"`,
    `data-count-prefix="${escapeHtml(parts.prefix)}"`,
    `data-count-suffix="${escapeHtml(parts.suffix)}"`,
    `data-count-decimals="${escapeHtml(parts.decimals)}"`
  ].join(" ");
}

function renderSprintHealthCards(cards) {
  if (!cards || cards.length === 0) {
    return "";
  }

  return `
    <div class="metric-card-grid">
      ${cards
        .map(
          (card) => `
            <div class="metric-card tone-${escapeHtml(card.tone || "blue")}">
              <span>${escapeHtml(card.label)}</span>
              <strong class="metric-value" ${renderMetricAnimationAttributes(card.value)}>${escapeHtml(card.value)}</strong>
              <small>${escapeHtml(card.detail || "")}</small>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function clampPercent(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(100, number));
}

function toDomId(value) {
  return String(value || "chart")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "chart";
}

function renderVelocityBars(velocity) {
  if (!velocity || !velocity.sprints || velocity.sprints.length === 0) {
    return `<div class="empty-state">No prior completed sprints were available for the velocity baseline.</div>`;
  }

  const maxPoints = Math.max(...velocity.sprints.map((sprint) => sprint.completedStoryPoints), 1);

  return `
    <div class="velocity-panel">
      <div class="velocity-average">
        <span>Average</span>
        <strong>${escapeHtml(formatNumber(velocity.averageCompletedPoints))} pts</strong>
      </div>
      <div class="velocity-bars">
        ${velocity.sprints
          .map((sprint) => {
            const width = clampPercent((sprint.completedStoryPoints / maxPoints) * 100);

            return `
              <div class="velocity-row">
                <div>
                  <span>${escapeHtml(sprint.name || "Sprint")}</span>
                </div>
                <div class="velocity-track" aria-label="${escapeHtml(`${sprint.name || "Sprint"} completed ${formatNumber(sprint.completedStoryPoints)} points`)}">
                  <div class="velocity-fill" style="width: ${width}%"></div>
                  <strong class="velocity-points">${escapeHtml(formatNumber(sprint.completedStoryPoints))} pts</strong>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function buildChartPath(series, valueKey, width, height, padding, maxValue) {
  if (!series || series.length === 0) {
    return "";
  }

  const usableWidth = width - padding.left - padding.right;
  const usableHeight = height - padding.top - padding.bottom;

  return series
    .map((point, index) => {
      const x = series.length === 1 ? padding.left + usableWidth / 2 : padding.left + (index / (series.length - 1)) * usableWidth;
      const y = padding.top + usableHeight - (Number(point[valueKey]) / maxValue) * usableHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function renderBurndownChart(burndown, title, label) {
  const chartTitle = String(title || "").trim();
  const chartLabel = String(label || "").trim();
  const chartHeading = chartTitle || chartLabel
    ? `
      <div class="chart-heading">
        ${chartLabel ? `<span>${escapeHtml(chartLabel)}</span>` : ""}
        ${chartTitle ? `<h3>${escapeHtml(chartTitle)}</h3>` : ""}
      </div>
    `
    : "";
  const accessibleTitle = chartTitle || chartLabel || "Burndown chart";

  if (!burndown || !burndown.series || burndown.series.length === 0) {
    return `
      <div class="chart-card">
        ${chartHeading}
        <div class="empty-state">No burndown series is available for this sprint.</div>
      </div>
    `;
  }

  const width = 680;
  const height = 280;
  const padding = { top: 24, right: 26, bottom: 44, left: 50 };
  const maxRemaining = Math.max(...burndown.series.map((point) => point.remainingStoryPoints), burndown.startStoryPoints, 1);
  const remainingPath = buildChartPath(burndown.series, "remainingStoryPoints", width, height, padding, maxRemaining);
  const idealSeries = burndown.series.map((point, index) => {
    const denominator = Math.max(burndown.series.length - 1, 1);
    const ideal = burndown.startStoryPoints * (1 - index / denominator);

    return {
      ...point,
      idealStoryPoints: Math.max(0, ideal)
    };
  });
  const idealPath = buildChartPath(idealSeries, "idealStoryPoints", width, height, padding, maxRemaining);
  const firstDate = burndown.series[0].date;
  const lastDate = burndown.series[burndown.series.length - 1].date;
  const finalPoint = burndown.series[burndown.series.length - 1];
  const finalUsableWidth = width - padding.left - padding.right;
  const finalUsableHeight = height - padding.top - padding.bottom;
  const finalX =
    burndown.series.length === 1
      ? padding.left + finalUsableWidth / 2
      : padding.left + finalUsableWidth;
  const finalY = padding.top + finalUsableHeight - (finalPoint.remainingStoryPoints / maxRemaining) * finalUsableHeight;
  const remainingAtEnd = Number(finalPoint.remainingStoryPoints || 0);
  const sprintCleared = remainingAtEnd <= 0;
  const markerX = Math.min(width - padding.right - 14, Math.max(padding.left + 14, finalX));
  const markerY = Math.max(padding.top + 14, Math.min(height - padding.bottom - 14, finalY));
  const outcomeLabel = sprintCleared
    ? "Sprint ended at zero remaining points"
    : `Sprint ended with ${formatNumber(remainingAtEnd)} remaining points`;
  const gradientId = `burnLine-${toDomId(`${chartLabel}-${chartTitle}-${accessibleTitle}`)}`;

  return `
    <div class="chart-card burndown-hero-card">
      ${chartHeading}
      <svg class="burndown-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(accessibleTitle)}">
        <defs>
          <linearGradient id="${escapeHtml(gradientId)}" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stop-color="#0076c0" />
            <stop offset="55%" stop-color="#0ebfca" />
            <stop offset="100%" stop-color="#ff5f91" />
          </linearGradient>
        </defs>
        <line class="chart-grid-line" x1="${padding.left}" x2="${width - padding.right}" y1="${padding.top}" y2="${padding.top}" />
        <line class="chart-grid-line" x1="${padding.left}" x2="${width - padding.right}" y1="${height - padding.bottom}" y2="${height - padding.bottom}" />
        <text class="chart-axis-label" x="${padding.left}" y="${padding.top - 8}">${escapeHtml(formatNumber(maxRemaining))} pts</text>
        <text class="chart-axis-label" x="${padding.left}" y="${height - 14}">${escapeHtml(firstDate)}</text>
        <text class="chart-axis-label end" x="${width - padding.right}" y="${height - 14}">${escapeHtml(lastDate)}</text>
        <path class="ideal-line" d="${idealPath}" pathLength="1" />
        <path class="burn-line" d="${remainingPath}" pathLength="1" stroke="url(#${escapeHtml(gradientId)})" />
        ${burndown.series
          .slice(0, -1)
          .map((point, index) => {
            const usableWidth = width - padding.left - padding.right;
            const usableHeight = height - padding.top - padding.bottom;
            const x =
              burndown.series.length === 1
                ? padding.left + usableWidth / 2
                : padding.left + (index / (burndown.series.length - 1)) * usableWidth;
            const y = padding.top + usableHeight - (point.remainingStoryPoints / maxRemaining) * usableHeight;

            return `<circle class="burn-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" />`;
          })
          .join("")}
        <circle class="burn-dot final" cx="${finalX.toFixed(1)}" cy="${finalY.toFixed(1)}" r="6" />
        <g class="burn-outcome-marker ${sprintCleared ? "is-complete" : "is-improve"}" transform="translate(${markerX.toFixed(1)} ${markerY.toFixed(1)})">
          <title>${escapeHtml(outcomeLabel)}</title>
          <circle r="12" />
          ${
            sprintCleared
              ? `<path d="M-5 .5 L-1.4 4.2 L6 -5" />`
              : `<path d="M0 -6 L0 2" /><circle class="marker-dot" cy="6" r="1.4" />`
          }
        </g>
      </svg>
    </div>
  `;
}

function renderMetricStoryList(title, items, emptyText) {
  if (!items || items.length === 0) {
    return `
      <div class="story-list-card">
        <span>${escapeHtml(title)}</span>
        <div class="empty-state">${escapeHtml(emptyText)}</div>
      </div>
    `;
  }

  return `
    <div class="story-list-card">
      <span>${escapeHtml(title)}</span>
      <div class="story-list">
        ${items
          .slice(0, 8)
          .map(
            (item) => `
              <div class="story-row">
                <strong>${escapeHtml(item.title)}</strong>
                <small>${escapeHtml(item.type)} ${escapeHtml(item.id)} &middot; ${escapeHtml(item.state)}${
                  item.storyPoints !== null && item.storyPoints !== undefined ? ` &middot; ${escapeHtml(formatNumber(item.storyPoints))} pts` : ""
                }${item.areaPath ? ` &middot; ${escapeHtml(areaPathLeaf(item.areaPath))}` : ""}</small>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null || value === "") {
    return [];
  }

  return [value];
}

function normalizeAreaPathList(value, fallback = "") {
  const rawValues = [...asArray(value), ...asArray(fallback)]
    .flatMap((entry) => String(entry || "").split(/\r?\n/))
    .map((entry) => entry.trim())
    .filter(Boolean);

  return [...new Set(rawValues)];
}

function primaryAreaPath(areaPaths, fallback = "") {
  return normalizeAreaPathList(areaPaths, fallback)[0] || "";
}

function areaPathLeaf(areaPath) {
  const clean = String(areaPath || "").trim();
  const parts = clean.split("\\").filter(Boolean);

  return parts[parts.length - 1] || clean;
}

function areaPathDisplay(areaPaths, fallback = "All team areas") {
  const paths = normalizeAreaPathList(areaPaths);

  if (paths.length === 0) {
    return fallback;
  }

  if (paths.length === 1) {
    return paths[0];
  }

  return `${paths.length} work areas: ${paths.map(areaPathLeaf).join(", ")}`;
}

function renderAreaPathHiddenInputs(areaPaths, fallback = "") {
  const paths = normalizeAreaPathList(areaPaths, fallback);
  const hiddenInputs = paths
    .map((areaPath) => `<input type="hidden" name="areaPaths" value="${escapeHtml(areaPath)}">`)
    .join("");

  return `
        <input type="hidden" name="areaPath" value="${escapeHtml(paths[0] || "")}">
        ${hiddenInputs}`;
}

function buildAdoAdminHrefForResult(result = {}) {
  const params = new URLSearchParams();
  const areaPaths = normalizeAreaPathList(result.areaPaths, result.areaPath);

  if (result.team) {
    params.set("team", result.team);
  }

  for (const areaPath of areaPaths) {
    params.append("areaPaths", areaPath);
  }

  if (areaPaths[0]) {
    params.set("areaPath", areaPaths[0]);
  }

  const query = params.toString();
  return query ? `/ado-admin?${query}` : "/ado-admin";
}

function getSavedReviewAreaPaths(review = {}, result = null) {
  const savedResult = result || review.result || {};
  return normalizeAreaPathList([...asArray(review.areaPaths), ...asArray(savedResult.areaPaths)], review.areaPath || savedResult.areaPath);
}

function getRawWorkItemFields(item) {
  return item && item.fields ? item.fields : item || {};
}

function rawWorkItemId(item) {
  const fields = getRawWorkItemFields(item);

  return String((item && (item.WorkItemId || item.id)) || fields["System.Id"] || "").trim();
}

function attachAreaPathToWorkItem(item, areaPath) {
  const cleanAreaPath = String(areaPath || "").trim();

  if (!cleanAreaPath || !item || typeof item !== "object") {
    return item;
  }

  if (item.fields) {
    return {
      ...item,
      AreaPath: item.AreaPath || cleanAreaPath,
      fields: {
        ...item.fields,
        "System.AreaPath": item.fields["System.AreaPath"] || cleanAreaPath
      }
    };
  }

  return {
    ...item,
    AreaPath: item.AreaPath || cleanAreaPath
  };
}

function mergeWorkItemResults(results) {
  const itemsById = new Map();
  const sourceNames = [];
  const warnings = [];

  for (const result of results || []) {
    if (!result) {
      continue;
    }

    if (result.source && !sourceNames.includes(result.source)) {
      sourceNames.push(result.source);
    }

    if (result.warning) {
      warnings.push(result.warning);
    }

    for (const item of result.items || []) {
      const id = rawWorkItemId(item) || JSON.stringify(item);

      if (!itemsById.has(id)) {
        itemsById.set(id, item);
        continue;
      }

      const existing = itemsById.get(id);
      const existingArea = String((existing && (existing.AreaPath || existing.areaPath)) || "").trim();
      const nextArea = String((item && (item.AreaPath || item.areaPath)) || "").trim();

      if (!existingArea && nextArea) {
        itemsById.set(id, attachAreaPathToWorkItem(existing, nextArea));
      }
    }
  }

  const items = [...itemsById.values()];

  return {
    source: sourceNames.length > 1 ? `Combined ${sourceNames.join(", ")}` : sourceNames[0] || "Combined work items",
    count: items.length,
    items,
    warning: [...new Set(warnings)].join(" ")
  };
}

async function queryIterationSnapshotRowsForAreas({ pat, org, project, team, iterationPath, areaPaths = [] }) {
  const selectedAreaPaths = normalizeAreaPathList(areaPaths);

  if (selectedAreaPaths.length === 0) {
    return queryIterationSnapshotRows({ pat, org, project, team, iterationPath, areaPath: "" });
  }

  const rows = [];

  for (const areaPath of selectedAreaPaths) {
    const areaRows = await queryIterationSnapshotRows({ pat, org, project, team, iterationPath, areaPath });
    rows.push(...areaRows.map((row) => ({ ...row, AreaPath: row.AreaPath || areaPath })));
  }

  return rows;
}

async function queryIterationWorkItemsForAreas({ pat, org, project, team, iterationPath, areaPaths = [] }) {
  const selectedAreaPaths = normalizeAreaPathList(areaPaths);

  if (selectedAreaPaths.length === 0) {
    return queryIterationWorkItems({ pat, org, project, team, iterationPath, areaPath: "" });
  }

  const results = [];

  for (const areaPath of selectedAreaPaths) {
    const result = await queryIterationWorkItems({ pat, org, project, team, iterationPath, areaPath });
    results.push({
      ...result,
      areaPath,
      items: (result.items || []).map((item) => attachAreaPathToWorkItem(item, areaPath))
    });
  }

  return mergeWorkItemResults(results);
}

function splitBullets(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
}

function splitNames(value) {
  return String(value || "")
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeIterationForDisplay(iteration) {
  if (!iteration) {
    return null;
  }

  return {
    id: iteration.id || "",
    name: iteration.name || getSprintLabel(iteration.path),
    path: iteration.path || "",
    startDate: (iteration.attributes && iteration.attributes.startDate) || iteration.startDate || "",
    finishDate: (iteration.attributes && iteration.attributes.finishDate) || iteration.finishDate || "",
    timeFrame: (iteration.attributes && iteration.attributes.timeFrame) || iteration.timeFrame || ""
  };
}

function normalizeStoryItems(items) {
  const reviewTypes = new Set(["user story", "bug"]);

  return (items || [])
    .map(normalizeWorkItem)
    .filter((item) => item.id || item.title)
    .filter((item) => reviewTypes.has(String(item.type || "").trim().toLowerCase()))
    .sort((a, b) => {
      const aType = String(a.type || "");
      const bType = String(b.type || "");
      const typeCompare = aType.localeCompare(bType);

      if (typeCompare !== 0) {
        return typeCompare;
      }

      return Number(a.id || 0) - Number(b.id || 0);
    });
}

function storyPointValue(item) {
  const points = Number(item && item.storyPoints);
  return Number.isFinite(points) ? points : 0;
}

function totalStoryPoints(items) {
  return (items || []).reduce((sum, item) => sum + storyPointValue(item), 0);
}

function storyMeta(item) {
  const parts = [
    `${item.type || "Work Item"} ${item.id || ""}`.trim(),
    item.state || "Unknown"
  ];

  if (item.storyPoints !== null && item.storyPoints !== undefined) {
    parts.push(`${formatNumber(item.storyPoints)} pts`);
  }

  if (item.areaPath) {
    parts.push(areaPathLeaf(item.areaPath));
  }

  return parts.filter(Boolean).map(escapeHtml).join(" &middot; ");
}

function buildStoryLookup(items) {
  return new Map((items || []).map((item) => [String(item.id), item]));
}

function selectStoriesById(items, selectedIds) {
  const lookup = buildStoryLookup(items);

  return asArray(selectedIds)
    .map((id) => lookup.get(String(id)))
    .filter(Boolean);
}

function renderStoryPicker({ title, name, items, emptyText, selectedIds = [] }) {
  const selected = new Set(asArray(selectedIds).map(String));
  const totalPoints = totalStoryPoints(items);

  if (!items || items.length === 0) {
    return `
      <div class="story-picker is-empty">
        <div class="story-picker-heading">
          <strong>${escapeHtml(title)}</strong>
          <span>0 stories</span>
        </div>
        <div class="empty-state">${escapeHtml(emptyText)}</div>
      </div>
    `;
  }

  return `
    <details class="story-picker" open data-story-picker>
      <summary>
        <span>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(items.length)} items available &middot; ${escapeHtml(formatNumber(totalPoints))} pts total</small>
        </span>
        <em data-picker-total>0 selected</em>
      </summary>
      <div class="story-checkbox-list">
        ${items
          .map((item) => {
            const id = String(item.id || "");
            return `
              <label class="story-checkbox">
                <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(id)}" data-points="${escapeHtml(storyPointValue(item))}"${
                  selected.has(id) ? " checked" : ""
                }>
                <span>
                  <strong>${escapeHtml(item.title)}</strong>
                  <small>${storyMeta(item)}</small>
                </span>
              </label>
            `;
          })
          .join("")}
      </div>
    </details>
  `;
}

function renderStoryChips(stories, emptyText = "", options = {}) {
  if (!stories || stories.length === 0) {
    return emptyText ? `<div class="empty-state">${escapeHtml(emptyText)}</div>` : "";
  }

  const preview = Boolean(options.preview);
  const visibleStories = preview ? stories.slice(0, options.previewLimit || 4) : [];
  const hiddenCount = Math.max(stories.length - visibleStories.length, 0);
  const pointSummary = totalStoryPoints(stories);
  const storyLabel = stories.length === 1 ? "User Story" : "User Stories";

  return `
    <div class="story-summary-pill">
      <strong>${escapeHtml(stories.length)} ${escapeHtml(storyLabel)} / ${escapeHtml(formatNumber(pointSummary))} pts</strong>
    </div>
    ${
      preview
        ? `<div class="linked-story-list preview">
            ${visibleStories
              .map(
                (story) => `
                  <article>
                    <span>${storyMeta(story)}</span>
                    <strong>${escapeHtml(story.title)}</strong>
                  </article>
                `
              )
              .join("")}
          </div>
          ${hiddenCount > 0 ? `<div class="linked-story-more">+ ${escapeHtml(hiddenCount)} more queued</div>` : ""}`
        : ""
    }
  `;
}

function renderBulletList(bullets, emptyText = "") {
  if (!bullets || bullets.length === 0) {
    return emptyText ? `<p>${escapeHtml(emptyText)}</p>` : "";
  }

  return `<ul>${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`;
}

function defaultSummaryText(result) {
  const totals = (result.metrics && result.metrics.totals) || {};
  const parts = [
    `${result.iteration.name} for ${result.team} focused on turning ADO-tracked sprint work into a clear stakeholder readout.`,
    `The sprint delivered ${formatNumber(totals.deliveredStoryPoints || 0)} story points across ${formatNumber(totals.completedItems || 0)} completed items.`
  ];

  return parts.join(" ");
}

function normalizeSectionType(value) {
  const type = String(value || "").trim().toLowerCase();
  return ["delivery", "screenshot", "challenge", "risk", "next_steps", "live_demo"].includes(type) ? type : "delivery";
}

function normalizeSectionId(value, index, type = "section") {
  const clean = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return clean || `${type}-${index + 1}`;
}

function normalizeRiskScale(value) {
  const scale = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high"].includes(scale) ? scale : "medium";
}

function normalizeRoamStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return ["resolved", "owned", "accepted", "mitigated"].includes(status) ? status : "owned";
}

function riskScaleLabel(value) {
  const labels = {
    low: "Low",
    medium: "Medium",
    high: "High"
  };

  return labels[normalizeRiskScale(value)];
}

function roamStatusLabel(value) {
  const labels = {
    resolved: "Resolved",
    owned: "Owned",
    accepted: "Accepted",
    mitigated: "Mitigated"
  };

  return labels[normalizeRoamStatus(value)];
}

function riskSeverity(section) {
  const scores = {
    low: 1,
    medium: 2,
    high: 3
  };
  const score = scores[normalizeRiskScale(section.impact)] * scores[normalizeRiskScale(section.likelihood)];

  if (score >= 7) return "critical";
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function allowedImageMime(mimeType) {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(mimeType || "").toLowerCase());
}

function isReviewImageDataUrl(value) {
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(String(value || ""));
}

function sectionFieldName(field, id) {
  return `section_${field}_${id}`;
}

function sectionLabel(type) {
  const labels = {
    delivery: "Delivery Update",
    screenshot: "Screenshot",
    challenge: "Challenge",
    risk: "Risk",
    next_steps: "Next Steps",
    live_demo: "Live Demo"
  };

  return labels[normalizeSectionType(type)];
}

function sectionIcon(type) {
  const icons = {
    delivery: "&#10003;",
    screenshot: "&#128247;",
    challenge: "&#9889;",
    risk: "&#9888;",
    next_steps: "&#8594;",
    live_demo: "&#9654;"
  };

  return icons[normalizeSectionType(type)];
}

function createDefaultReviewSection(type, index = 0, id = "") {
  const normalizedType = normalizeSectionType(type);
  const sectionId = normalizeSectionId(id, index, normalizedType);
  const base = {
    id: sectionId,
    type: normalizedType,
    title: "",
    bullets: [],
    businessValue: ""
  };

  if (normalizedType === "delivery") {
    return {
      ...base,
      stories: [],
      priority: false
    };
  }

  if (normalizedType === "next_steps") {
    return {
      ...base,
      stories: []
    };
  }

  if (normalizedType === "screenshot") {
    return {
      ...base,
      imageData: "",
      imageName: ""
    };
  }

  if (normalizedType === "challenge") {
    return base;
  }

  if (normalizedType === "live_demo") {
    return {
      ...base,
      title: "Live Demo",
      enabled: false,
      presenters: [],
      note: ""
    };
  }

  return {
    ...base,
    description: "",
    impact: "medium",
    likelihood: "medium",
    roam: "owned",
    owner: "",
    notes: ""
  };
}

function normalizeReviewSection(section, index = 0) {
  const source = section || {};
  const type = normalizeSectionType(source.type);
  const normalized = createDefaultReviewSection(type, index, source.id);

  normalized.title = String(source.title || (type === "live_demo" ? normalized.title : "")).trim();

  if (type === "risk") {
    normalized.description = String(source.description || "").trim();
    normalized.impact = normalizeRiskScale(source.impact);
    normalized.likelihood = normalizeRiskScale(source.likelihood);
    normalized.roam = normalizeRoamStatus(source.roam || source.status);
    normalized.owner = String(source.owner || "").trim();
    normalized.notes = String(source.notes || "").trim();
    return normalized;
  }

  if (type === "live_demo") {
    const presenters = Array.isArray(source.presenters)
      ? source.presenters.map((presenter) => String(presenter || "").trim()).filter(Boolean)
      : [];
    const note = String(source.note || "").trim();
    const customTitle = normalized.title && normalized.title.toLowerCase() !== "live demo";

    normalized.enabled = Boolean(source.enabled || customTitle || presenters.length > 0 || note);
    normalized.presenters = presenters;
    normalized.note = note;
    return normalized;
  }

  normalized.bullets = Array.isArray(source.bullets) ? source.bullets.map((bullet) => String(bullet || "").trim()).filter(Boolean) : [];
  normalized.businessValue = String(source.businessValue || "").trim();

  if (type === "delivery") {
    normalized.stories = Array.isArray(source.stories) ? source.stories : [];
    normalized.priority = Boolean(source.priority);
  }

  if (type === "next_steps") {
    normalized.stories = Array.isArray(source.stories) ? source.stories : [];
  }

  if (type === "screenshot") {
    normalized.imageData = isReviewImageDataUrl(source.imageData) ? source.imageData : "";
    normalized.imageName = String(source.imageName || "").trim();
  }

  return normalized;
}

function reviewSectionHasContent(section) {
  if (!section) return false;

  if (section.type === "risk") {
    return Boolean(section.title || section.description || section.owner || section.notes);
  }

  if (section.type === "screenshot") {
    return Boolean(section.title || section.bullets.length > 0 || section.businessValue || section.imageData);
  }

  if (section.type === "delivery") {
    return Boolean(section.title || section.bullets.length > 0 || section.businessValue || section.stories.length > 0 || section.priority);
  }

  if (section.type === "next_steps") {
    return Boolean(section.title || section.bullets.length > 0 || section.businessValue || section.stories.length > 0);
  }

  if (section.type === "live_demo") {
    return Boolean(
      section.enabled ||
        (section.title && section.title.toLowerCase() !== "live demo") ||
        (Array.isArray(section.presenters) && section.presenters.length > 0) ||
        section.note
    );
  }

  return Boolean(section.title || section.bullets.length > 0 || section.businessValue);
}

function normalizeNarrativeSections(narrative) {
  const currentNarrative = narrative || {};
  const rawSections = Array.isArray(currentNarrative.sections)
    ? currentNarrative.sections
    : (currentNarrative.updates || []).map((update) => ({
        ...update,
        type: "delivery"
      }));

  const sections = rawSections.map(normalizeReviewSection).filter(reviewSectionHasContent);
  const legacyNextSteps = normalizeReviewSection(
    {
      id: "next-steps-legacy",
      type: "next_steps",
      title: currentNarrative.nextSteps && currentNarrative.nextSteps.title,
      bullets: currentNarrative.nextSteps && currentNarrative.nextSteps.bullets,
      stories: currentNarrative.nextSteps && currentNarrative.nextSteps.stories
    },
    sections.length
  );

  if (!sections.some((section) => section.type === "next_steps") && reviewSectionHasContent(legacyNextSteps)) {
    sections.push(legacyNextSteps);
  }

  const legacyDemo = normalizeReviewSection(
    {
      id: "live-demo-legacy",
      type: "live_demo",
      enabled: currentNarrative.demo && currentNarrative.demo.enabled,
      title: currentNarrative.demo && currentNarrative.demo.title,
      presenters: currentNarrative.demo && currentNarrative.demo.presenters,
      note: currentNarrative.demo && currentNarrative.demo.note
    },
    sections.length
  );

  if (!sections.some((section) => section.type === "live_demo") && reviewSectionHasContent(legacyDemo)) {
    sections.push(legacyDemo);
  }

  return sections;
}

function sectionsForBuilder(narrative) {
  const sections = normalizeNarrativeSections(narrative);
  return sections.length > 0
    ? sections
    : [
        createDefaultReviewSection("delivery", 0, "delivery-1"),
        createDefaultReviewSection("next_steps", 1, "next-steps-1"),
        createDefaultReviewSection("live_demo", 2, "live-demo-1")
      ];
}

function deliveryUpdatesFromSections(sections) {
  return (sections || []).filter((section) => section.type === "delivery");
}

function nextStepsFromSections(sections) {
  const section = (sections || []).find((candidate) => candidate.type === "next_steps");

  if (!section) {
    return {
      title: "",
      bullets: [],
      stories: []
    };
  }

  return {
    title: section.title || "",
    bullets: Array.isArray(section.bullets) ? section.bullets : [],
    stories: Array.isArray(section.stories) ? section.stories : []
  };
}

function demoFromSections(sections) {
  const section = (sections || []).find((candidate) => candidate.type === "live_demo");

  if (!section || !reviewSectionHasContent(section)) {
    return {
      enabled: false,
      title: "",
      presenters: [],
      note: ""
    };
  }

  return {
    enabled: true,
    title: section.title || "Live Demo",
    presenters: Array.isArray(section.presenters) ? section.presenters : [],
    note: section.note || ""
  };
}

function normalizeReadinessAudience(value, fallback = {}) {
  const source = value || {};
  const stories = Array.isArray(source.stories) ? source.stories : [];

  return {
    enabled: Boolean(source.enabled || source.ready || stories.length > 0),
    stories,
    message: String(source.message || fallback.message || "").trim()
  };
}

function normalizeEnvironmentReadiness(narrative) {
  const readiness = (narrative && narrative.environmentReadiness) || {};

  return {
    training: normalizeReadinessAudience(readiness.training, {
      message: "We have items ready to go into the training environment."
    }),
    uat: normalizeReadinessAudience(readiness.uat, {
      message: "We have items ready to go into UAT."
    })
  };
}

function environmentReadinessHasContent(readiness) {
  const normalized = normalizeEnvironmentReadiness({ environmentReadiness: readiness });
  return Boolean(normalized.training.enabled || normalized.uat.enabled);
}

function parseEnvironmentReadiness(body, currentItems, previousNarrative = {}) {
  const previous = normalizeEnvironmentReadiness(previousNarrative);
  const trainingStories = selectStoriesById(currentItems, body.readinessTrainingStoryIds);
  const uatStories = selectStoriesById(currentItems, body.readinessUatStoryIds);

  return {
    training: {
      enabled: Boolean(body.readinessTrainingEnabled) || trainingStories.length > 0,
      stories: trainingStories,
      message: String(body.readinessTrainingMessage || previous.training.message || "We have items ready to go into the training environment.").trim()
    },
    uat: {
      enabled: Boolean(body.readinessUatEnabled) || uatStories.length > 0,
      stories: uatStories,
      message: String(body.readinessUatMessage || previous.uat.message || "We have items ready to go into UAT.").trim()
    }
  };
}

function previousSectionsById(narrative) {
  return new Map(normalizeNarrativeSections(narrative).map((section) => [section.id, section]));
}

function findUploadedImage(files, fieldName) {
  return (files || []).find((file) => file.fieldname === fieldName && file.buffer && file.size > 0) || null;
}

function uploadedImageToDataUrl(file) {
  if (!file || !allowedImageMime(file.mimetype)) {
    return "";
  }

  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

function parseSectionFromRequest({ body, files, id, index, currentItems, nextItems, previousSections }) {
  const type = normalizeSectionType(body[sectionFieldName("type", id)]);
  const section = createDefaultReviewSection(type, index, id);

  section.title = String(body[sectionFieldName("title", id)] || "").trim();

  if (type === "risk") {
    section.description = String(body[sectionFieldName("description", id)] || "").trim();
    section.impact = normalizeRiskScale(body[sectionFieldName("impact", id)]);
    section.likelihood = normalizeRiskScale(body[sectionFieldName("likelihood", id)]);
    section.roam = normalizeRoamStatus(body[sectionFieldName("roam", id)]);
    section.owner = String(body[sectionFieldName("owner", id)] || "").trim();
    section.notes = String(body[sectionFieldName("notes", id)] || "").trim();
    return section;
  }

  if (type === "live_demo") {
    section.presenters = splitNames(body[sectionFieldName("presenters", id)]);
    section.note = String(body[sectionFieldName("note", id)] || "").trim();
    section.enabled = Boolean(
      body[sectionFieldName("enabled", id)] ||
        (section.title && section.title.toLowerCase() !== "live demo") ||
        section.presenters.length > 0 ||
        section.note
    );
    return section;
  }

  section.bullets = splitBullets(body[sectionFieldName("bullets", id)]);
  section.businessValue = String(body[sectionFieldName("businessValue", id)] || "").trim();

  if (type === "delivery") {
    section.priority = Boolean(body[sectionFieldName("priority", id)]);
    section.stories = selectStoriesById(currentItems, body[sectionFieldName("storyIds", id)]);
  }

  if (type === "next_steps") {
    section.stories = selectStoriesById(nextItems, body[sectionFieldName("storyIds", id)]);
  }

  if (type === "screenshot") {
    const imageFile = findUploadedImage(files, sectionFieldName("image", id));
    const previous = previousSections.get(id);
    const removeImage = Boolean(body[sectionFieldName("imageRemove", id)]);

    section.imageData = removeImage ? "" : uploadedImageToDataUrl(imageFile) || (previous && previous.imageData) || "";
    section.imageName = imageFile ? String(imageFile.originalname || "").trim() : (previous && previous.imageName) || "";
  }

  return section;
}

function parseLegacyDeliveryUpdates(body, currentItems) {
  const priorityUpdates = new Set([0, 1, 2].filter((index) => body[`updatePriority${index}`]));

  return [0, 1, 2]
    .map((index) =>
      normalizeReviewSection(
        {
          id: `delivery-${index + 1}`,
          type: "delivery",
          title: String(body[`updateTitle${index}`] || "").trim(),
          bullets: splitBullets(body[`updateBullets${index}`]),
          businessValue: String(body[`updateBusinessValue${index}`] || "").trim(),
          stories: selectStoriesById(currentItems, body[`updateStoryIds${index}`]),
          priority: priorityUpdates.has(index)
        },
        index
      )
    )
    .filter(reviewSectionHasContent);
}

function parseReviewSections(body, currentItems, nextItems, files, previousNarrative) {
  const sectionIds = asArray(body.sectionIds).map((id, index) => normalizeSectionId(id, index)).filter(Boolean);

  if (sectionIds.length === 0) {
    return parseLegacyDeliveryUpdates(body, currentItems);
  }

  const previousSections = previousSectionsById(previousNarrative);
  return sectionIds
    .map((id, index) =>
      parseSectionFromRequest({
        body,
        files,
        id,
        index,
        currentItems,
        nextItems,
        previousSections
      })
    )
    .filter(reviewSectionHasContent);
}

function parseAdoNarrative(body, currentItems, nextItems, files = [], previousNarrative = {}) {
  const sections = parseReviewSections(body, currentItems, nextItems, files, previousNarrative);

  if (!sections.some((section) => section.type === "live_demo")) {
    const legacyDemoSection = normalizeReviewSection(
      {
        id: "live-demo-legacy",
        type: "live_demo",
        enabled: Boolean(body.hasDemo),
        title: String(body.demoTitle || "").trim(),
        presenters: splitNames(body.demoPresenters),
        note: String(body.demoNote || "").trim()
      },
      sections.length
    );

    if (reviewSectionHasContent(legacyDemoSection)) {
      sections.push(legacyDemoSection);
    }
  }

  const sectionNextSteps = nextStepsFromSections(sections);
  const nextSteps = reviewSectionHasContent({ ...sectionNextSteps, type: "next_steps" })
    ? sectionNextSteps
    : {
        title: String(body.nextTitle || "").trim(),
        bullets: splitBullets(body.nextBullets),
        stories: selectStoriesById(nextItems, body.nextStoryIds)
      };
  const demo = demoFromSections(sections);

  return {
    summary: String(body.summary || "").trim(),
    openingTitle: String(body.openingTitle || "Opening Remarks").trim(),
    openingSubtitle: String(body.openingSubtitle || "").trim(),
    sections,
    updates: deliveryUpdatesFromSections(sections),
    demo,
    nextSteps,
    environmentReadiness: parseEnvironmentReadiness(body, currentItems, previousNarrative)
  };
}

async function buildAdoReviewDraft({ pat, team, sprint, areaPath = "", areaPaths = [] }) {
  const selectedAreaPaths = normalizeAreaPathList(areaPaths, areaPath);
  const result = await buildAdoDataPreview({ pat, team, sprint, areaPaths: selectedAreaPaths });
  const currentItems = normalizeStoryItems(result.workItems.items);
  const completedItems = result.metrics && result.metrics.items ? normalizeStoryItems(result.metrics.items.completed) : [];
  const nextIteration = normalizeIterationForDisplay(findNextIteration(result.iterations || [], result.iteration));
  let nextWorkItems = {
    source: "Not checked",
    count: 0,
    items: [],
    warning: ""
  };

  if (nextIteration) {
    try {
      nextWorkItems = await queryIterationWorkItemsForAreas({
        pat,
        org: adoConfig.org,
        project: adoConfig.project,
        team,
        iterationPath: nextIteration.path,
        areaPaths: result.areaPaths
      });
    } catch (error) {
      nextWorkItems.warning = `Next sprint stories could not be loaded: ${error.message}`;
    }
  }

  const nextItems = normalizeStoryItems(nextWorkItems.items);

  return {
    result,
    currentItems,
    completedItems,
    nextIteration,
    nextWorkItems: {
      ...nextWorkItems,
      items: nextItems,
      count: nextItems.length
    }
  };
}

function renderSectionSelect(name, value, options) {
  return `
    <select class="text-input" name="${escapeHtml(name)}">
      ${options
        .map(
          (option) => `
            <option value="${escapeHtml(option.value)}"${option.value === value ? " selected" : ""}>${escapeHtml(option.label)}</option>
          `
        )
        .join("")}
    </select>
  `;
}

function renderSectionControls(section, index) {
  const type = normalizeSectionType(section.type);
  const descriptions = {
    delivery: "Tell the delivery story",
    screenshot: "Show and explain a visual",
    challenge: "Capture a challenge",
    risk: "Track a ROAM risk",
    next_steps: "Preview what comes next",
    live_demo: "Pause for a live demo"
  };

  return `
    <div class="section-editor-topline">
      <div class="section-editor-title-row">
        <span class="section-icon" aria-hidden="true">${sectionIcon(type)}</span>
        <div>
          <span class="section-kicker">${escapeHtml(sectionLabel(type))} <em data-section-number>${escapeHtml(index + 1)}</em></span>
          <strong>${escapeHtml(descriptions[type] || descriptions.delivery)}</strong>
        </div>
      </div>
      <div class="section-editor-actions">
        <button class="ghost-button compact" type="button" data-section-move="up">Up</button>
        <button class="ghost-button compact" type="button" data-section-move="down">Down</button>
        <button class="ghost-button compact danger" type="button" data-section-remove>Remove</button>
      </div>
    </div>
  `;
}

function renderCommonSectionFields(section) {
  const id = section.id;
  const placeholders = {
    delivery: "Example: Enrollment workflow is ready for demo",
    screenshot: "Example: Dashboard view is ready for feedback",
    challenge: "Example: Vendor dependency slowed validation",
    risk: "Example: Integration timeline may slip",
    next_steps: "Example: Sprint 38 focus",
    live_demo: "Live Demo"
  };

  return `
    <input type="hidden" name="sectionIds" value="${escapeHtml(id)}">
    <input type="hidden" name="${escapeHtml(sectionFieldName("type", id))}" value="${escapeHtml(section.type)}">
    <label class="field-group" for="${escapeHtml(sectionFieldName("title", id))}">
      <span>Title</span>
      <input class="text-input" id="${escapeHtml(sectionFieldName("title", id))}" name="${escapeHtml(sectionFieldName("title", id))}" type="text" value="${escapeHtml(section.title || "")}" placeholder="${escapeHtml(placeholders[normalizeSectionType(section.type)] || placeholders.delivery)}">
    </label>
  `;
}

function renderDeliverySectionEditor(section, draft) {
  const id = section.id;

  return `
    ${renderCommonSectionFields(section)}
    <div class="delivery-card-topline section-subline">
      <span>Delivery detail</span>
      <label class="priority-check">
        <input type="checkbox" name="${escapeHtml(sectionFieldName("priority", id))}" value="yes"${section.priority ? " checked" : ""}>
        <span>#1 priority</span>
      </label>
    </div>
    <label class="field-group" for="${escapeHtml(sectionFieldName("bullets", id))}">
      <span>Bullet points</span>
      <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("bullets", id))}" name="${escapeHtml(sectionFieldName("bullets", id))}" rows="4" placeholder="One bullet per line">${escapeHtml((section.bullets || []).join("\n"))}</textarea>
    </label>
    <label class="field-group" for="${escapeHtml(sectionFieldName("businessValue", id))}">
      <span>Business value</span>
      <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("businessValue", id))}" name="${escapeHtml(sectionFieldName("businessValue", id))}" rows="3" placeholder="Why this mattered for users, stakeholders, or operations">${escapeHtml(section.businessValue || "")}</textarea>
    </label>
    ${renderStoryPicker({
      title: "Attach selected sprint ADO stories",
      name: sectionFieldName("storyIds", id),
      items: draft.currentItems,
      emptyText: "No stories or bugs were found for this sprint.",
      selectedIds: storyIdsFromSelection(section.stories)
    })}
  `;
}

function renderScreenshotSectionEditor(section) {
  const id = section.id;
  const hasImage = Boolean(section.imageData);

  return `
    ${renderCommonSectionFields(section)}
    <div class="screenshot-editor-grid">
      <div class="screenshot-drop-zone" tabindex="0" data-screenshot-drop>
        <input type="hidden" name="${escapeHtml(sectionFieldName("imageRemove", id))}" value="" data-screenshot-remove>
        <input class="text-input" type="file" name="${escapeHtml(sectionFieldName("image", id))}" accept="image/png,image/jpeg,image/webp,image/gif" data-screenshot-input>
        <div class="screenshot-preview${hasImage ? " has-image" : ""}" data-screenshot-preview>
          ${hasImage ? `<img src="${escapeHtml(section.imageData)}" alt="${escapeHtml(section.title || "Uploaded screenshot")}">` : `<span>Paste, drop, or choose a screenshot</span>`}
        </div>
        <button class="ghost-button compact" type="button" data-screenshot-clear${hasImage ? "" : " hidden"}>Remove image</button>
      </div>
      <div class="screenshot-copy-fields">
        <label class="field-group" for="${escapeHtml(sectionFieldName("bullets", id))}">
          <span>Side bullets</span>
          <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("bullets", id))}" name="${escapeHtml(sectionFieldName("bullets", id))}" rows="5" placeholder="One bullet per line">${escapeHtml((section.bullets || []).join("\n"))}</textarea>
        </label>
        <label class="field-group" for="${escapeHtml(sectionFieldName("businessValue", id))}">
          <span>Business value</span>
          <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("businessValue", id))}" name="${escapeHtml(sectionFieldName("businessValue", id))}" rows="3" placeholder="Why this screenshot matters">${escapeHtml(section.businessValue || "")}</textarea>
        </label>
      </div>
    </div>
  `;
}

function renderChallengeSectionEditor(section) {
  const id = section.id;

  return `
    ${renderCommonSectionFields(section)}
    <label class="field-group" for="${escapeHtml(sectionFieldName("bullets", id))}">
      <span>Challenge bullets</span>
      <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("bullets", id))}" name="${escapeHtml(sectionFieldName("bullets", id))}" rows="4" placeholder="One challenge or learning per line">${escapeHtml((section.bullets || []).join("\n"))}</textarea>
    </label>
    <label class="field-group" for="${escapeHtml(sectionFieldName("businessValue", id))}">
      <span>Impact or response</span>
      <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("businessValue", id))}" name="${escapeHtml(sectionFieldName("businessValue", id))}" rows="3" placeholder="How the team responded or what stakeholders should know">${escapeHtml(section.businessValue || "")}</textarea>
    </label>
  `;
}

function renderRiskSectionEditor(section) {
  const id = section.id;

  return `
    ${renderCommonSectionFields(section)}
    <label class="field-group" for="${escapeHtml(sectionFieldName("description", id))}">
      <span>Description</span>
      <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("description", id))}" name="${escapeHtml(sectionFieldName("description", id))}" rows="3" placeholder="What could happen and why it matters">${escapeHtml(section.description || "")}</textarea>
    </label>
    <div class="risk-editor-grid">
      <label class="field-group">
        <span>Impact</span>
        ${renderSectionSelect(sectionFieldName("impact", id), normalizeRiskScale(section.impact), [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" }
        ])}
      </label>
      <label class="field-group">
        <span>Likelihood</span>
        ${renderSectionSelect(sectionFieldName("likelihood", id), normalizeRiskScale(section.likelihood), [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" }
        ])}
      </label>
      <label class="field-group">
        <span>ROAM</span>
        ${renderSectionSelect(sectionFieldName("roam", id), normalizeRoamStatus(section.roam), [
          { value: "resolved", label: "Resolved" },
          { value: "owned", label: "Owned" },
          { value: "accepted", label: "Accepted" },
          { value: "mitigated", label: "Mitigated" }
        ])}
      </label>
    </div>
    <div class="risk-editor-grid two">
      <label class="field-group" for="${escapeHtml(sectionFieldName("owner", id))}">
        <span>Owner</span>
        <input class="text-input" id="${escapeHtml(sectionFieldName("owner", id))}" name="${escapeHtml(sectionFieldName("owner", id))}" type="text" value="${escapeHtml(section.owner || "")}" placeholder="Example: Product owner">
      </label>
      <label class="field-group" for="${escapeHtml(sectionFieldName("notes", id))}">
        <span>Notes</span>
        <input class="text-input" id="${escapeHtml(sectionFieldName("notes", id))}" name="${escapeHtml(sectionFieldName("notes", id))}" type="text" value="${escapeHtml(section.notes || "")}" placeholder="Example: Mitigation plan is in motion">
      </label>
    </div>
  `;
}

function renderNextStepsSectionEditor(section, draft) {
  const id = section.id;

  return `
    ${renderCommonSectionFields(section)}
    <label class="field-group" for="${escapeHtml(sectionFieldName("bullets", id))}">
      <span>Next steps bullets</span>
      <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("bullets", id))}" name="${escapeHtml(sectionFieldName("bullets", id))}" rows="5" placeholder="One bullet per line">${escapeHtml((section.bullets || []).join("\n"))}</textarea>
    </label>
    <label class="field-group" for="${escapeHtml(sectionFieldName("businessValue", id))}">
      <span>Context for stakeholders</span>
      <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("businessValue", id))}" name="${escapeHtml(sectionFieldName("businessValue", id))}" rows="3" placeholder="Why this is the right next focus">${escapeHtml(section.businessValue || "")}</textarea>
    </label>
    ${renderStoryPicker({
      title: "Attach next sprint ADO stories",
      name: sectionFieldName("storyIds", id),
      items: draft.nextWorkItems.items,
      emptyText: "No next sprint stories were found or the next iteration is not configured for this team.",
      selectedIds: storyIdsFromSelection(section.stories)
    })}
  `;
}

function renderLiveDemoSectionEditor(section) {
  const id = section.id;
  const presenters = Array.isArray(section.presenters) ? section.presenters.join("\n") : "";

  return `
    ${renderCommonSectionFields(section)}
    <div class="demo-toggle-panel">
      <label class="demo-check">
        <input type="checkbox" name="${escapeHtml(sectionFieldName("enabled", id))}" value="yes"${section.enabled ? " checked" : ""}>
        <span>
          <strong>This review includes a live demo</strong>
          <small>Adds a clean demo slide wherever this section sits in the review.</small>
        </span>
      </label>
      <label class="field-group" for="${escapeHtml(sectionFieldName("presenters", id))}">
        <span>Presenter names</span>
        <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("presenters", id))}" name="${escapeHtml(sectionFieldName("presenters", id))}" rows="3" placeholder="One presenter per line">${escapeHtml(presenters)}</textarea>
      </label>
      <label class="field-group" for="${escapeHtml(sectionFieldName("note", id))}">
        <span>Demo note</span>
        <textarea class="text-input narrative-textarea" id="${escapeHtml(sectionFieldName("note", id))}" name="${escapeHtml(sectionFieldName("note", id))}" rows="3" placeholder="Example: Product owner will demo the workflow.">${escapeHtml(section.note || "")}</textarea>
      </label>
    </div>
  `;
}

function renderReadinessAudienceEditor({ key, label, description, checked, message, stories, items }) {
  const enabledName = key === "training" ? "readinessTrainingEnabled" : "readinessUatEnabled";
  const storyName = key === "training" ? "readinessTrainingStoryIds" : "readinessUatStoryIds";
  const messageName = key === "training" ? "readinessTrainingMessage" : "readinessUatMessage";

  return `
    <article class="readiness-audience-card">
      <label class="demo-check">
        <input type="checkbox" name="${escapeHtml(enabledName)}" value="yes"${checked ? " checked" : ""}>
        <span>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(description)}</small>
        </span>
      </label>
      <label class="field-group" for="${escapeHtml(messageName)}">
        <span>Fallback message when no stories are selected</span>
        <input class="text-input" id="${escapeHtml(messageName)}" name="${escapeHtml(messageName)}" type="text" value="${escapeHtml(message)}" placeholder="${escapeHtml(key === "training" ? "We have items ready to go into the training environment." : "We have items ready to go into UAT.")}">
      </label>
      ${renderStoryPicker({
        title: `Choose specific stories for ${label}`,
        name: storyName,
        items,
        emptyText: "No current sprint stories were found for this review.",
        selectedIds: storyIdsFromSelection(stories)
      })}
    </article>
  `;
}

function renderEnvironmentReadinessEditor(readiness, draft) {
  const normalized = normalizeEnvironmentReadiness({ environmentReadiness: readiness });

  return `
    <section class="narrative-section readiness-builder-section">
      <div class="section-heading-row">
        <div>
          <span>Stakeholder readiness</span>
          <h2>What this means for you</h2>
        </div>
        <small>Show Training and UAT what they should prepare for after the review.</small>
      </div>
      <div class="readiness-editor-grid">
        ${renderReadinessAudienceEditor({
          key: "training",
          label: "Training Environment",
          description: "Stories expected to move into training so materials can be prepared.",
          checked: normalized.training.enabled,
          message: normalized.training.message,
          stories: normalized.training.stories,
          items: draft.currentItems
        })}
        ${renderReadinessAudienceEditor({
          key: "uat",
          label: "UAT",
          description: "Stories or features expected to need UAT preparation and test planning.",
          checked: normalized.uat.enabled,
          message: normalized.uat.message,
          stories: normalized.uat.stories,
          items: draft.currentItems
        })}
      </div>
    </section>
  `;
}

function renderReviewSectionEditor(section, index, draft) {
  const normalizedSection = normalizeReviewSection(section, typeof index === "number" ? index : 0);
  const type = normalizedSection.type;
  const body =
    type === "screenshot"
      ? renderScreenshotSectionEditor(normalizedSection)
      : type === "challenge"
        ? renderChallengeSectionEditor(normalizedSection)
        : type === "risk"
          ? renderRiskSectionEditor(normalizedSection)
          : type === "next_steps"
            ? renderNextStepsSectionEditor(normalizedSection, draft)
            : type === "live_demo"
              ? renderLiveDemoSectionEditor(normalizedSection)
              : renderDeliverySectionEditor(normalizedSection, draft);

  return `
    <article class="delivery-editor-card review-section-card section-type-${escapeHtml(type)}" data-review-section>
      ${renderSectionControls(normalizedSection, typeof index === "number" ? index : 0)}
      ${body}
    </article>
  `;
}

function renderReviewSectionTemplate(type, draft) {
  return `
    <template data-section-template="${escapeHtml(type)}">
      ${renderReviewSectionEditor(createDefaultReviewSection(type, 0, "__SECTION_ID__"), 0, draft)}
    </template>
  `;
}

function renderAdoReviewBuilderContent({
  draft,
  error = null,
  inline = false,
  narrative = null,
  action = "/ado-admin/generate-report",
  submitLabel = "Generate Report",
  backHref = "",
  backLabel = "Back to selections",
  savedMode = false
} = {}) {
  if (!draft) {
    return `
        <section class="result-card error-card">
          <div class="eyebrow">Sprint Review Builder</div>
          <h1>Load a team and sprint first.</h1>
          <p class="lede">${escapeHtml(error && error.message ? error.message : "Choose a sprint to start the review builder.")}</p>
          <div class="result-actions">
            <a class="primary-button" href="/ado-admin">Back to Review Builder</a>
          </div>
        </section>
      `;
  }

  const result = draft.result;
  const metrics = result.metrics || {};
  const totals = metrics.totals || {};
  const currentNarrative = narrative || {};
  const reviewSections = sectionsForBuilder(currentNarrative);
  const readiness = normalizeEnvironmentReadiness(currentNarrative);
  const openingTitle = currentNarrative.openingTitle || "Opening Remarks";
  const openingSubtitle = currentNarrative.openingSubtitle || "";
  const summaryText = currentNarrative.summary || defaultSummaryText(result);
  const backLinkHref = backHref || buildAdoAdminHrefForResult(result);
  const warningHtml = filterContributorWarnings([draft.nextWorkItems.warning, ...(result.warnings || [])], metrics.contributors)
    .map((warning) => `<li>${escapeHtml(warning)}</li>`)
    .join("");

  return `
      <section class="ado-admin-header builder-header">
        <div>
          <div class="eyebrow">Sprint Review Builder</div>
          <h1>Curate the review before Scrum Studio packages it.</h1>
          <p class="lede">ADO is supplying the metrics and story wording. You add the human context: what mattered, why it mattered, and what comes next.</p>
        </div>
        ${inline ? "" : `<a class="secondary-button" href="${escapeHtml(backLinkHref)}">${escapeHtml(backLabel)}</a>`}
      </section>

      ${warningHtml ? `<div class="alert alert-warn builder-warning"><strong>Review note:</strong><ul>${warningHtml}</ul></div>` : ""}

      <section class="builder-facts-grid">
        <div class="builder-fact-card">
          <span>Completed</span>
          <strong>${escapeHtml(formatNumber(totals.completedItems || 0))}</strong>
          <small>${escapeHtml(formatNumber(totals.deliveredStoryPoints || 0))} delivered story points</small>
        </div>
        <div class="builder-fact-card">
          <span>Completion rate</span>
          <strong>${escapeHtml(formatNumber(totals.completionRate || 0))}%</strong>
          <small>Delivered points divided by committed points</small>
        </div>
      </section>

      <form class="story-builder-form" action="${escapeHtml(action)}" method="post" enctype="multipart/form-data" data-review-builder-form>
        <input type="hidden" name="team" value="${escapeHtml(result.team)}">
        <input type="hidden" name="sprint" value="${escapeHtml(result.iteration.path)}">
        ${renderAreaPathHiddenInputs(result.areaPaths, result.areaPath)}

        <section class="narrative-section">
          <div class="section-heading-row">
            <div>
              <span>Executive summary</span>
              <h2>Write the opening remarks</h2>
            </div>
            <small>Use plain language your stakeholders will recognize.</small>
          </div>
          <div class="opening-copy-grid">
            <label class="field-group" for="openingTitle">
              <span>Opening slide title</span>
              <input class="text-input" id="openingTitle" name="openingTitle" type="text" value="${escapeHtml(openingTitle)}" placeholder="Example: Opening Remarks">
            </label>
            <label class="field-group" for="openingSubtitle">
              <span>Opening slide subtitle</span>
              <input class="text-input" id="openingSubtitle" name="openingSubtitle" type="text" value="${escapeHtml(openingSubtitle)}" placeholder="Example: by Product Owner name">
            </label>
          </div>
          <label class="field-group" for="summary">
            <span>Sprint summary</span>
            <textarea class="text-input narrative-textarea" id="summary" name="summary" rows="5">${escapeHtml(summaryText)}</textarea>
          </label>
        </section>

        <section class="narrative-section review-sections-builder">
          <div class="section-heading-row">
            <div>
              <span>Review sections</span>
              <h2>Build the stakeholder story section by section</h2>
            </div>
            <small>Add delivery updates, screenshots, challenges, risks, next steps, or a live demo in the order you want them presented.</small>
          </div>

          <div class="section-add-row" aria-label="Add review section">
            <button class="secondary-button" type="button" data-add-section="delivery">Delivery Update</button>
            <button class="secondary-button" type="button" data-add-section="screenshot">Screenshot</button>
            <button class="secondary-button" type="button" data-add-section="challenge">Challenge</button>
            <button class="secondary-button" type="button" data-add-section="risk">Risk</button>
            <button class="secondary-button" type="button" data-add-section="next_steps">Next Steps</button>
            <button class="secondary-button" type="button" data-add-section="live_demo">Live Demo</button>
          </div>

          <div class="delivery-editor-grid review-section-list" data-section-list>
            ${reviewSections.map((section, index) => renderReviewSectionEditor(section, index, draft)).join("")}
          </div>
          ${["delivery", "screenshot", "challenge", "risk", "next_steps", "live_demo"].map((type) => renderReviewSectionTemplate(type, draft)).join("")}
        </section>

        ${renderEnvironmentReadinessEditor(readiness, draft)}

        <section class="builder-submit-panel">
          <div>
            <span>Ready</span>
            <strong>${savedMode ? "Update the saved HTML report and Presentation Mode from this review." : "Generate the HTML report and Presentation Mode from this curated review."}</strong>
            <small>${savedMode ? "This uses the saved ADO snapshot. A PAT is only needed if you explicitly refresh ADO facts." : "The PAT remains in memory only. The generated job stores ADO facts and your approved narrative, not the PAT."}</small>
          </div>
          <button class="primary-button" type="submit">${escapeHtml(submitLabel)}</button>
        </section>
      </form>
    `;
}

function renderAdoReviewBuilderPage({
  draft,
  error = null,
  narrative = null,
  action = "/ado-admin/generate-report",
  submitLabel = "Generate Report",
  backHref = "",
  backLabel = "Back to selections",
  savedMode = false
} = {}) {
  return renderPage({
    title: "Scrum Studio - Build Sprint Review",
    bodyClass: "ado-page builder-page",
    content: renderAdoReviewBuilderContent({
      draft,
      error,
      narrative,
      action,
      submitLabel,
      backHref,
      backLabel,
      savedMode
    })
  });
}

function renderAdoReportBusinessValue(value) {
  return value ? `<div class="business-value-box"><span>Business value</span><p>${escapeHtml(value)}</p></div>` : "";
}

function renderAdoReportDeliverySection(section, index) {
  return `
    <article class="ado-report-update-card${section.priority ? " priority" : ""}">
      <div class="update-card-heading">
        <h3>${escapeHtml(section.title || `Delivery update ${index + 1}`)}</h3>
        ${section.priority ? `<span>#1 priority</span>` : ""}
      </div>
      ${renderBulletList(section.bullets, "No bullet points were added for this update.")}
      ${renderAdoReportBusinessValue(section.businessValue)}
      ${
        section.stories && section.stories.length > 0
          ? `<div class="story-evidence">
              ${renderStoryChips(section.stories)}
            </div>`
          : ""
      }
    </article>
  `;
}

function renderAdoReportScreenshotSection(section) {
  return `
    <article class="ado-report-special-card screenshot-report-card">
      <div class="section-special-heading">
        <span aria-hidden="true">${sectionIcon("screenshot")}</span>
        <div>
          <small>Screenshot</small>
          <h3>${escapeHtml(section.title || "Screenshot")}</h3>
        </div>
      </div>
      <div class="screenshot-report-layout">
        <div class="screenshot-report-media">
          ${section.imageData ? `<img src="${escapeHtml(section.imageData)}" alt="${escapeHtml(section.title || "Review screenshot")}">` : `<div class="empty-state">No screenshot was added.</div>`}
        </div>
        <div class="screenshot-report-copy">
          ${renderBulletList(section.bullets, "No screenshot notes were added.")}
          ${renderAdoReportBusinessValue(section.businessValue)}
        </div>
      </div>
    </article>
  `;
}

function renderAdoReportChallengeSection(section) {
  return `
    <article class="ado-report-special-card challenge-report-card">
      <div class="section-special-heading">
        <span aria-hidden="true">${sectionIcon("challenge")}</span>
        <div>
          <small>Challenge</small>
          <h3>${escapeHtml(section.title || "Challenge")}</h3>
        </div>
      </div>
      ${renderBulletList(section.bullets, "No challenge notes were added.")}
      ${renderAdoReportBusinessValue(section.businessValue)}
    </article>
  `;
}

function renderAdoReportRiskSection(section) {
  const severity = riskSeverity(section);

  return `
    <article class="ado-report-special-card risk-report-card severity-${escapeHtml(severity)}">
      <div class="section-special-heading">
        <span aria-hidden="true">${sectionIcon("risk")}</span>
        <div>
          <small>Risk</small>
          <h3>${escapeHtml(section.title || "Risk")}</h3>
        </div>
      </div>
      ${section.description ? `<p>${escapeHtml(section.description)}</p>` : `<p>No risk description was added.</p>`}
      <div class="risk-heatmap-row">
        <span>Impact: ${escapeHtml(riskScaleLabel(section.impact))}</span>
        <span>Likelihood: ${escapeHtml(riskScaleLabel(section.likelihood))}</span>
        <span>ROAM: ${escapeHtml(roamStatusLabel(section.roam))}</span>
      </div>
      ${
        section.owner || section.notes
          ? `<div class="risk-owner-notes">
              ${section.owner ? `<span>Owner: ${escapeHtml(section.owner)}</span>` : ""}
              ${section.notes ? `<span>${escapeHtml(section.notes)}</span>` : ""}
            </div>`
          : ""
      }
    </article>
  `;
}

function renderAdoReportNextStepsSection(section, nextIteration) {
  return `
    <article class="ado-report-special-card next-report-card">
      <div class="section-special-heading">
        <span aria-hidden="true">${sectionIcon("next_steps")}</span>
        <div>
          <small>${escapeHtml(nextIteration ? nextIteration.name : "Looking ahead")}</small>
          <h3>${escapeHtml(section.title || "What is lining up next")}</h3>
        </div>
      </div>
      <div class="ado-report-next-grid${section.stories && section.stories.length > 0 ? "" : " single"}">
        <div class="next-copy-panel">
          ${renderBulletList(section.bullets, "No next-step bullets were added.")}
          ${renderAdoReportBusinessValue(section.businessValue)}
        </div>
        ${
          section.stories && section.stories.length > 0
            ? `<div class="story-evidence">
                <span>Next sprint stories</span>
                ${renderStoryChips(section.stories, "", { preview: true, previewLimit: 4 })}
              </div>`
            : ""
        }
      </div>
    </article>
  `;
}

function renderAdoReportLiveDemoSection(section) {
  const presenters = Array.isArray(section.presenters) ? section.presenters : [];

  return `
    <article class="ado-report-special-card demo-report-card">
      <div class="section-special-heading">
        <span aria-hidden="true">${sectionIcon("live_demo")}</span>
        <div>
          <small>Live demo</small>
          <h3>${escapeHtml(section.title || "Live Demo")}</h3>
        </div>
      </div>
      ${
        presenters.length > 0
          ? `<div class="demo-presenter-list">
              <span>Presenters</span>
              ${presenters.map((presenter) => `<strong>${escapeHtml(presenter)}</strong>`).join("")}
            </div>`
          : ""
      }
      ${section.note ? `<p>${escapeHtml(section.note)}</p>` : ""}
    </article>
  `;
}

function renderAdoReportSection(section, index, nextIteration) {
  if (section.type === "screenshot") {
    return renderAdoReportScreenshotSection(section);
  }

  if (section.type === "challenge") {
    return renderAdoReportChallengeSection(section);
  }

  if (section.type === "risk") {
    return renderAdoReportRiskSection(section);
  }

  if (section.type === "next_steps") {
    return renderAdoReportNextStepsSection(section, nextIteration);
  }

  if (section.type === "live_demo") {
    return renderAdoReportLiveDemoSection(section);
  }

  return renderAdoReportDeliverySection(section, index);
}

function renderAdoNarrativeSections(sections, nextIteration = null) {
  if (!sections || sections.length === 0) {
    return `<div class="empty-state">No review sections were added. Return to the builder to add stakeholder-facing context.</div>`;
  }

  return `
    <div class="ado-report-section-stack">
      ${sections.map((section, index) => renderAdoReportSection(section, index, nextIteration)).join("")}
    </div>
  `;
}

function renderAdoDeliveryUpdates(updates) {
  const sections = (updates || []).map((update, index) => normalizeReviewSection({ ...update, type: "delivery" }, index));
  return renderAdoNarrativeSections(sections);
}

function renderAdoNextSteps(nextSteps, nextIteration) {
  if (!nextSteps || (!nextSteps.title && nextSteps.bullets.length === 0 && nextSteps.stories.length === 0)) {
    return `<div class="empty-state">No looking-ahead details were added yet.</div>`;
  }

  return `
    <div class="ado-report-next-grid${nextSteps.stories && nextSteps.stories.length > 0 ? "" : " single"}">
      <div class="next-copy-panel">
        <span>${escapeHtml(nextIteration ? nextIteration.name : "Looking ahead")}</span>
        <h3>${escapeHtml(nextSteps.title || "Looking ahead")}</h3>
        ${renderBulletList(nextSteps.bullets, "No next-step bullets were added.")}
      </div>
      ${
        nextSteps.stories && nextSteps.stories.length > 0
          ? `<div class="story-evidence">
              <span>Next sprint stories</span>
              ${renderStoryChips(nextSteps.stories, "", { preview: true, previewLimit: 4 })}
            </div>`
          : ""
      }
    </div>
  `;
}

function renderAdoDemoSection(demo) {
  if (!demo || !demo.enabled) {
    return "";
  }

  const presenters = Array.isArray(demo.presenters) ? demo.presenters : [];

  return `
    <section class="ado-report-section">
      <div>
        <span>Live demo</span>
        <h2>${escapeHtml(demo.title || "Live Demo")}</h2>
      </div>
      <div class="demo-report-card">
        ${
          presenters.length > 0
            ? `<div class="demo-presenter-list">
                <span>Presenters</span>
                ${presenters.map((presenter) => `<strong>${escapeHtml(presenter)}</strong>`).join("")}
              </div>`
            : ""
        }
        <p>${escapeHtml(demo.note || "This sprint review includes a live demo.")}</p>
      </div>
    </section>
  `;
}

function renderAdoReadinessAudience(title, audience) {
  if (!audience || !audience.enabled) {
    return "";
  }

  const stories = Array.isArray(audience.stories) ? audience.stories : [];
  const hasStories = stories.length > 0;
  const fallbackMessage =
    audience.message ||
    (title === "Training Environment"
      ? "We have items ready to go into the training environment."
      : "We have items ready to go into UAT.");

  return `
    <article class="readiness-report-card">
      <div>
        <span>${escapeHtml(hasStories ? title : "Readiness")}</span>
        <h3>${escapeHtml(hasStories ? `${stories.length} item${stories.length === 1 ? "" : "s"} expected` : title)}</h3>
      </div>
      ${
        hasStories
          ? renderStoryChips(stories, "", { preview: true, previewLimit: 5 })
          : `<p>${escapeHtml(fallbackMessage)}</p>`
      }
    </article>
  `;
}

function renderAdoEnvironmentReadiness(readiness) {
  const normalized = normalizeEnvironmentReadiness({ environmentReadiness: readiness });

  if (!environmentReadinessHasContent(normalized)) {
    return "";
  }

  return `
    <section class="ado-report-section readiness-report-section">
      <div>
        <span>Stakeholder readiness</span>
        <h2>What this means for you</h2>
      </div>
      <div class="readiness-report-grid">
        ${renderAdoReadinessAudience("Training Environment", normalized.training)}
        ${renderAdoReadinessAudience("UAT", normalized.uat)}
      </div>
    </section>
  `;
}

function renderAdoReportStyles() {
  return `
    * { box-sizing: border-box; }
    body {
      background: #f5fbfe;
      color: #10212c;
      font-family: "Plus Jakarta Sans", "Segoe UI", Arial, sans-serif;
      margin: 0;
    }
    .ado-report-document {
      background:
        radial-gradient(circle at 12% 8%, rgba(255, 209, 102, .28), transparent 25%),
        radial-gradient(circle at 88% 4%, rgba(14, 191, 202, .2), transparent 24%),
        linear-gradient(180deg, #f7fcff 0%, #eef9fb 44%, #ffffff 100%);
      min-height: 100vh;
      padding: 34px;
    }
    .ado-report-shell {
      margin: 0 auto;
      max-width: 1120px;
    }
    .ado-report-brand-rail {
      align-items: center;
      background: rgba(255, 255, 255, .88);
      border: 1px solid rgba(220, 231, 236, .9);
      border-radius: 12px;
      display: flex;
      min-height: 36px;
      padding: 7px 14px;
      margin-bottom: 12px;
    }
    .ado-report-brand-rail .brand-rail-logo {
      display: block;
      height: auto;
      max-height: 22px;
      width: min(178px, 48vw);
    }
    .ado-report-hero {
      background:
        linear-gradient(135deg, rgba(0, 118, 192, .96), rgba(14, 191, 202, .9) 52%, rgba(255, 95, 145, .88)),
        #0076c0;
      border-radius: 16px;
      box-shadow: 0 26px 70px rgba(16, 33, 44, .18);
      color: #ffffff;
      overflow: hidden;
      padding: 44px;
      position: relative;
    }
    .ado-report-hero::after {
      background: linear-gradient(90deg, rgba(255, 255, 255, .28), transparent);
      bottom: 0;
      content: "";
      height: 7px;
      left: 0;
      position: absolute;
      right: 0;
    }
    .ado-report-hero span,
    .ado-report-section > div:first-child span,
    .metric-card span,
    .chart-heading span,
    .velocity-average span,
    .velocity-row span,
    .update-card-heading span,
    .business-value-box span,
    .story-evidence > span,
    .ado-report-contributors > span,
    .next-copy-panel > span,
    .readiness-report-card > div:first-child span {
      display: block;
      font-size: .72rem;
      font-weight: 800;
      letter-spacing: .1em;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .ado-report-hero h1 {
      font-size: 3.8rem;
      letter-spacing: -.05em;
      line-height: .98;
      margin: 0;
      max-width: 920px;
    }
    .ado-report-hero p {
      font-size: 1.06rem;
      font-weight: 650;
      line-height: 1.65;
      margin: 22px 0 0;
      max-width: 900px;
    }
    .hero-facts {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, 1fr);
      margin-top: 28px;
    }
    .hero-facts div {
      background: rgba(255, 255, 255, .16);
      border: 1px solid rgba(255, 255, 255, .28);
      border-radius: 10px;
      padding: 16px;
    }
    .hero-facts strong {
      display: block;
      font-size: .95rem;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .ado-report-contributors {
      background: rgba(255, 255, 255, .18);
      border: 1px solid rgba(255, 255, 255, .3);
      border-radius: 10px;
      margin-top: 14px;
      padding: 16px;
    }
    .ado-report-contributor-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .ado-report-contributor-list span {
      background: rgba(255, 255, 255, .18);
      border: 1px solid rgba(255, 255, 255, .34);
      border-radius: 999px;
      color: #ffffff;
      display: inline-flex;
      font-size: .78rem;
      font-weight: 800;
      line-height: 1;
      padding: 8px 10px;
    }
    .ado-report-section {
      background: rgba(255, 255, 255, .88);
      border: 1px solid rgba(220, 231, 236, .9);
      border-radius: 14px;
      box-shadow: 0 20px 60px rgba(16, 33, 44, .1);
      margin-top: 22px;
      padding: 28px;
    }
    .ado-report-section h2 {
      font-size: 2rem;
      letter-spacing: -.035em;
      line-height: 1.08;
      margin: 0 0 18px;
    }
    .ado-report-section > div:first-child:has(+ .metric-card-grid),
    .ado-report-section > div:first-child:has(+ .chart-card) {
      margin-bottom: 14px;
    }
    .metric-card-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(3, 1fr);
    }
    .metric-card,
    .chart-card,
    .velocity-panel,
    .ado-report-update-card,
    .next-copy-panel,
    .story-evidence,
    .readiness-report-card {
      background: #ffffff;
      border: 1px solid #dce7ec;
      border-radius: 10px;
    }
    .metric-card {
      min-height: 132px;
      padding: 18px;
    }
    .metric-card strong {
      display: block;
      font-size: 2.45rem;
      font-variant-numeric: tabular-nums;
      letter-spacing: -.04em;
      line-height: .95;
    }
    .metric-card small,
    .velocity-average small,
    .velocity-row small,
    .linked-story-list span,
    .chart-caption span {
      color: #61727e;
      display: block;
      font-size: .76rem;
      font-weight: 700;
      line-height: 1.45;
      margin-top: 8px;
    }
    .chart-card,
    .velocity-panel {
      padding: 18px;
    }
    .chart-heading {
      align-items: start;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .chart-heading h3 {
      font-size: 1.2rem;
      margin: 0;
      text-align: right;
    }
    .burndown-svg {
      display: block;
      width: 100%;
    }
    .chart-grid-line { stroke: rgba(97, 114, 126, .24); stroke-width: 1; }
    .chart-axis-label { fill: #61727e; font-size: 13px; font-weight: 800; }
    .chart-axis-label.end { text-anchor: end; }
    .ideal-line {
      fill: none;
      stroke: rgba(97, 114, 126, .55);
      stroke-dasharray: 7 7;
      stroke-linecap: round;
      stroke-width: 3;
    }
    .burn-line {
      fill: none;
      stroke-dasharray: none;
      stroke-dashoffset: 0;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 5;
    }
    .burn-dot {
      fill: #ffffff;
      opacity: 1;
      stroke: #0ebfca;
      stroke-width: 3;
    }
    .burn-dot.final {
      fill: #10212c;
      stroke: #ffd166;
      stroke-width: 4;
    }
    .burn-outcome-marker circle {
      filter: drop-shadow(0 8px 14px rgba(16, 33, 44, .18));
      stroke-width: 2;
    }
    .burn-outcome-marker path {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 3;
    }
    .burn-outcome-marker .marker-dot {
      stroke: none;
    }
    .burn-outcome-marker.is-complete circle {
      fill: #1b8a45;
      stroke: rgba(255, 255, 255, .92);
    }
    .burn-outcome-marker.is-complete path {
      stroke: #ffffff;
    }
    .burn-outcome-marker.is-improve circle {
      fill: #ffd166;
      stroke: #10212c;
    }
    .burn-outcome-marker.is-improve path {
      stroke: #10212c;
    }
    .burn-outcome-marker.is-improve .marker-dot {
      fill: #10212c;
    }
    .chart-caption {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: space-between;
      margin-top: 8px;
    }
    .chart-caption span {
      background: #e8f6ff;
      border: 1px solid #d7eefb;
      border-radius: 999px;
      padding: 8px 10px;
    }
    .chart-caption strong { color: #10212c; }
    .velocity-panel {
      display: grid;
      gap: 18px;
      grid-template-columns: minmax(190px, .34fr) minmax(0, 1fr);
    }
    .velocity-average {
      background: #fff6d8;
      border: 1px solid #ffe39a;
      border-radius: 10px;
      padding: 18px;
    }
    .velocity-average strong {
      display: block;
      font-size: 2.8rem;
      letter-spacing: -.05em;
      line-height: .95;
    }
    .velocity-bars {
      display: grid;
      gap: 14px;
    }
    .velocity-row {
      align-items: center;
      display: grid;
      gap: 12px;
      grid-template-columns: minmax(120px, .32fr) minmax(0, 1fr);
    }
    .velocity-track {
      background: #edf5f8;
      border-radius: 999px;
      height: 32px;
      overflow: hidden;
      position: relative;
    }
    .velocity-fill {
      background: linear-gradient(90deg, #0076c0, #0ebfca, #ff5f91);
      border-radius: inherit;
      height: 100%;
      min-width: 8px;
      position: absolute;
      inset: 0 auto 0 0;
      z-index: 1;
    }
    .velocity-points {
      background: rgba(255, 255, 255, .94);
      border: 1px solid rgba(255, 255, 255, .8);
      border-radius: 999px;
      box-shadow: 0 8px 18px rgba(16, 33, 44, .14);
      color: #10212c;
      font-size: .95rem;
      font-weight: 850;
      line-height: 1;
      min-width: 64px;
      padding: 7px 10px;
      position: absolute;
      right: 6px;
      text-align: center;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2;
    }
    .ado-report-update-grid {
      display: grid;
      gap: 16px;
    }
    .ado-report-section-stack {
      display: grid;
      gap: 16px;
    }
    .ado-report-update-card {
      border-left: 6px solid #0ebfca;
      padding: 22px;
    }
    .ado-report-special-card {
      background: #ffffff;
      border: 1px solid #dce7ec;
      border-radius: 10px;
      box-shadow: 0 16px 34px rgba(16, 33, 44, .08);
      padding: 22px;
    }
    .section-special-heading {
      align-items: center;
      display: flex;
      gap: 14px;
      margin-bottom: 16px;
    }
    .section-special-heading > span {
      align-items: center;
      background: #edf8fd;
      border: 1px solid #d7eefb;
      border-radius: 12px;
      color: #0076c0;
      display: inline-flex;
      font-size: 1.35rem;
      height: 44px;
      justify-content: center;
      width: 44px;
    }
    .section-special-heading small {
      color: #0076c0;
      display: block;
      font-size: .72rem;
      font-weight: 850;
      letter-spacing: .12em;
      margin-bottom: 4px;
      text-transform: uppercase;
    }
    .section-special-heading h3 {
      font-size: 1.45rem;
      letter-spacing: -.025em;
      line-height: 1.15;
      margin: 0;
    }
    .screenshot-report-layout {
      display: grid;
      gap: 18px;
      grid-template-columns: minmax(0, 1fr) minmax(280px, .85fr);
    }
    .screenshot-report-media {
      align-items: center;
      background: #f3fbff;
      border: 1px solid #d7eefb;
      border-radius: 10px;
      display: flex;
      justify-content: center;
      min-height: 240px;
      overflow: hidden;
    }
    .screenshot-report-media img {
      display: block;
      max-height: 520px;
      max-width: 100%;
      object-fit: contain;
      width: 100%;
    }
    .screenshot-report-copy {
      display: grid;
      gap: 12px;
    }
    .challenge-report-card {
      border-left: 6px solid #0076c0;
    }
    .risk-report-card {
      border-left: 6px solid #0ebfca;
    }
    .next-report-card {
      border-left: 6px solid #0076c0;
    }
    .risk-report-card.severity-low { border-left-color: #6fcf97; }
    .risk-report-card.severity-medium { border-left-color: #ffd166; }
    .risk-report-card.severity-high { border-left-color: #f59e0b; }
    .risk-report-card.severity-critical { border-left-color: #ef476f; }
    .risk-report-card p {
      font-size: 1rem;
      font-weight: 700;
      line-height: 1.6;
      margin: 0 0 14px;
    }
    .risk-heatmap-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    .risk-heatmap-row span,
    .risk-owner-notes span,
    .demo-presenter-list strong {
      background: #f8fcff;
      border: 1px solid #dce7ec;
      border-radius: 999px;
      color: #10212c;
      display: inline-flex;
      font-size: .78rem;
      font-weight: 850;
      padding: 8px 10px;
    }
    .risk-owner-notes {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
    }
    .ado-report-update-card.priority {
      border-left-color: #ffd166;
      box-shadow: 0 18px 42px rgba(255, 209, 102, .22);
    }
    .update-card-heading {
      align-items: start;
      display: flex;
      gap: 16px;
      justify-content: space-between;
    }
    .update-card-heading h3,
    .next-copy-panel h3 {
      font-size: 1.45rem;
      letter-spacing: -.025em;
      line-height: 1.15;
      margin: 0 0 14px;
    }
    ul {
      margin: 0;
      padding-left: 22px;
    }
    li {
      font-size: .97rem;
      line-height: 1.6;
      margin: 6px 0;
    }
    .business-value-box {
      background:
        linear-gradient(135deg, rgba(255, 209, 102, .28), rgba(14, 191, 202, .12)),
        #fffaf0;
      border: 1px solid #ffe39a;
      border-radius: 10px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .9), 0 16px 34px rgba(122, 84, 0, .1);
      margin-top: 16px;
      padding: 18px;
      position: relative;
    }
    .business-value-box p {
      color: #3a2a05;
      font-size: 1rem;
      font-weight: 750;
      line-height: 1.55;
      margin: 0;
    }
    .story-evidence {
      margin-top: 16px;
      padding: 16px;
    }
    .story-summary-pill {
      align-items: center;
      background:
        linear-gradient(135deg, rgba(0, 118, 192, .1), rgba(14, 191, 202, .1)),
        #f8fcff;
      border: 1px solid #d7eefb;
      border-radius: 999px;
      display: inline-flex;
      max-width: 100%;
      padding: 9px 12px;
    }
    .story-summary-pill strong {
      color: #10212c;
      font-size: .82rem;
      font-weight: 850;
      line-height: 1.2;
    }
    .story-summary-pill span {
      color: #0076c0;
      letter-spacing: 0;
      margin: 0;
      text-transform: none;
    }
    .linked-story-list {
      display: grid;
      gap: 10px;
    }
    .linked-story-list.preview {
      margin-top: 12px;
    }
    .linked-story-list article {
      background: #f8fcff;
      border: 1px solid #dce7ec;
      border-radius: 8px;
      padding: 12px;
    }
    .linked-story-list strong {
      display: block;
      font-size: .88rem;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .ado-report-next-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr);
    }
    .ado-report-next-grid.single {
      grid-template-columns: 1fr;
    }
    .next-copy-panel {
      padding: 22px;
    }
    .readiness-report-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .readiness-report-card {
      background:
        radial-gradient(circle at 92% 8%, rgba(14, 191, 202, .14), transparent 32%),
        #ffffff;
      display: grid;
      gap: 14px;
      min-height: 180px;
      padding: 22px;
    }
    .readiness-report-card h3 {
      font-size: 1.45rem;
      letter-spacing: -.025em;
      line-height: 1.15;
      margin: 0;
    }
    .readiness-report-card p {
      color: #10212c;
      font-size: 1rem;
      font-weight: 750;
      line-height: 1.55;
      margin: 0;
    }
    .demo-report-card {
      background:
        radial-gradient(circle, rgba(0, 118, 192, .18) 0 2px, transparent 3px) 0 0 / 18px 18px,
        linear-gradient(135deg, #ffffff, #f3fbff);
      border: 1px dashed #9fd6ef;
      border-radius: 10px;
      padding: 22px;
    }
    .demo-report-card p {
      font-size: 1rem;
      font-weight: 700;
      line-height: 1.6;
      margin: 0;
    }
    .demo-presenter-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
    }
    .demo-presenter-list > span {
      color: #0076c0;
      font-size: .72rem;
      font-weight: 850;
      letter-spacing: .12em;
      text-transform: uppercase;
      width: 100%;
    }
    .linked-story-more {
      background: #edf8fd;
      border: 1px solid #d7eefb;
      border-radius: 999px;
      color: #61727e;
      display: inline-flex;
      font-size: .72rem;
      font-weight: 800;
      margin-bottom: 10px;
      padding: 7px 10px;
    }
    .linked-story-more {
      margin-bottom: 0;
      margin-top: 10px;
    }
    .linked-story-list.compact {
      gap: 8px;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    }
    .linked-story-list.compact article {
      padding: 9px;
    }
    .linked-story-list.compact span {
      font-size: .58rem;
      margin-bottom: 5px;
    }
    .linked-story-list.compact strong {
      display: -webkit-box;
      font-size: .76rem;
      line-height: 1.28;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }
    .empty-state {
      background: #fff6d8;
      border: 1px solid #ffe39a;
      border-radius: 10px;
      color: #7a5400;
      font-size: .88rem;
      font-weight: 750;
      line-height: 1.5;
      padding: 16px;
    }
    .ado-report-footer {
      color: #61727e;
      font-size: .8rem;
      font-weight: 700;
      margin-top: 24px;
      text-align: center;
    }
    @media print {
      .ado-report-document { padding: 0; }
      .ado-report-section,
      .ado-report-hero {
        box-shadow: none;
        break-inside: avoid;
      }
    }
    @media (max-width: 760px) {
      .ado-report-document { padding: 18px; }
      .ado-report-hero { padding: 28px; }
      .ado-report-hero h1 { font-size: 2.5rem; }
      .hero-facts,
      .metric-card-grid,
      .velocity-panel,
      .velocity-row,
      .ado-report-next-grid,
      .readiness-report-grid,
      .screenshot-report-layout {
        grid-template-columns: 1fr;
      }
      .velocity-points { text-align: center; }
    }
  `;
}

function renderMetricCountScript() {
  return `
  <script>
    (function () {
      var values = Array.prototype.slice.call(document.querySelectorAll("[data-count-target]"));

      if (!values.length) {
        return;
      }

      var prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      function formatMetricValue(element, value) {
        var prefix = element.getAttribute("data-count-prefix") || "";
        var suffix = element.getAttribute("data-count-suffix") || "";
        var decimals = Number(element.getAttribute("data-count-decimals") || 0);
        var safeDecimals = Number.isFinite(decimals) ? Math.max(0, Math.min(2, decimals)) : 0;
        var formatted = Number(value).toLocaleString("en-US", {
          minimumFractionDigits: safeDecimals,
          maximumFractionDigits: safeDecimals
        });

        return prefix + formatted + suffix;
      }

      function setFinalValue(element) {
        var target = Number(element.getAttribute("data-count-target") || 0);
        element.textContent = formatMetricValue(element, Number.isFinite(target) ? target : 0);
      }

      function animateValue(element) {
        if (element.dataset.countAnimated === "true") {
          return;
        }

        element.dataset.countAnimated = "true";

        var target = Number(element.getAttribute("data-count-target") || 0);

        if (!Number.isFinite(target) || prefersReducedMotion) {
          setFinalValue(element);
          return;
        }

        var duration = 1150;
        var startedAt = 0;

        element.textContent = formatMetricValue(element, 0);

        function frame(now) {
          if (!startedAt) {
            startedAt = now;
          }

          var progress = Math.min((now - startedAt) / duration, 1);
          var eased = 1 - Math.pow(1 - progress, 3);
          element.textContent = formatMetricValue(element, target * eased);

          if (progress < 1) {
            window.requestAnimationFrame(frame);
          } else {
            setFinalValue(element);
          }
        }

        window.requestAnimationFrame(frame);
      }

      if (!("IntersectionObserver" in window)) {
        values.forEach(animateValue);
        return;
      }

      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateValue(entry.target);
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: .35 });

      values.forEach(function (element) {
        observer.observe(element);
      });
    }());
  </script>`;
}

function renderAdoReportContributors(contributors) {
  if (!contributors || contributors.length === 0) {
    return "";
  }

  return `
    <div class="ado-report-contributors">
      <span>Sprint contributors</span>
      <div class="ado-report-contributor-list">
        ${contributors.map((name) => `<span>${escapeHtml(name)}</span>`).join("")}
      </div>
    </div>
  `;
}

function renderAdoReportHtml(report) {
  const result = report.result || report;
  const narrative = report.narrative || {};
  const metrics = result.metrics || {};
  const summary = narrative.summary || defaultSummaryText(result);
  const generatedAt = report.generatedAt || new Date().toISOString().slice(0, 10);
  const nextIteration = report.nextIteration || null;
  const narrativeSections = normalizeNarrativeSections(narrative);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(result.iteration.name)} - SprintGen ADO Report</title>
  <style>${renderAdoReportStyles()}</style>
</head>
<body class="ado-report-document">
  <main class="ado-report-shell">
    ${renderBrandRail({ className: "brand-rail ado-report-brand-rail" })}

    <header class="ado-report-hero">
      <span>SprintGen ADO report</span>
      <h1>${escapeHtml(result.iteration.name)}</h1>
      <p>${escapeHtml(summary)}</p>
      <div class="hero-facts">
        <div><span>Team</span><strong>${escapeHtml(result.team)}</strong></div>
        <div><span>Work areas</span><strong>${escapeHtml(areaPathDisplay(normalizeAreaPathList(result.areaPaths, result.areaPath)))}</strong></div>
        <div><span>Dates</span><strong>${escapeHtml(formatDateOnly(result.iteration.startDate))} to ${escapeHtml(formatDateOnly(result.iteration.finishDate))}</strong></div>
      </div>
      ${renderAdoReportContributors(metrics.contributors)}
    </header>

    <section class="ado-report-section">
      <div>
        <span>Agile Metrics</span>
      </div>
      ${renderSprintHealthCards(metrics.sprintHealthCards)}
    </section>

    <section class="ado-report-section">
      <div>
        <span>Burndown Chart</span>
      </div>
      ${renderBurndownChart(metrics.selectedBurndown)}
    </section>

    <section class="ado-report-section">
      <div>
        <span>Velocity</span>
        <h2>Last 3 completed sprints</h2>
      </div>
      ${renderVelocityBars(metrics.velocity)}
    </section>

    <section class="ado-report-section">
      <div>
        <span>Sprint story</span>
        <h2>Highlights, screenshots, challenges, risks, and next steps</h2>
      </div>
      ${renderAdoNarrativeSections(narrativeSections, nextIteration)}
    </section>

    ${renderAdoEnvironmentReadiness(narrative.environmentReadiness)}

    <footer class="ado-report-footer">
      Generated by SprintGen on ${escapeHtml(generatedAt)}. ADO supplied facts and story wording. Scrum master narrative was reviewed on screen before generation.
    </footer>
  </main>
  ${renderMetricCountScript()}
</body>
</html>`;
}

function renderAdoReportResultPage({ jobId, report }) {
  const result = report.result || report;
  const metrics = result.metrics || {};
  const savedReviewId = report.savedReviewId || "";
  const warnings = filterContributorWarnings(result.warnings || [], metrics.contributors);
  const warningHtml =
    warnings.length > 0
      ? `<div class="alert alert-warn"><strong>Review note:</strong><ul>${warnings
          .map((warning) => `<li>${escapeHtml(warning)}</li>`)
          .join("")}</ul></div>`
      : "";
  return renderPage({
    title: "Scrum Studio - Review Ready",
    bodyClass: "result-page ado-page",
    content: `
      <section class="result-card ado-report-ready-card">
        <div class="success-orb">ready</div>
        <div class="eyebrow">Review Ready</div>
        <h1>${escapeHtml(result.iteration.name)} is packaged for stakeholders.</h1>
        ${warningHtml}
        <div class="result-actions">
          <a class="primary-button" href="/download-html/${encodeURIComponent(jobId)}">Download HTML</a>
          <a class="secondary-button strong" href="/preview/${encodeURIComponent(jobId)}" target="_blank" rel="noreferrer">Open HTML report</a>
          ${savedReviewId ? `<a class="secondary-button" href="/reviews/${encodeURIComponent(savedReviewId)}/edit">Edit saved review</a>` : ""}
          ${savedReviewId ? `<a class="ghost-button" href="/reviews">Saved reviews</a>` : ""}
          <a class="ghost-button" href="/ado-admin">Build another review</a>
        </div>
        <div class="present-launch">
          <span>Presentation Mode</span>
          <p>Choose the screen-share vibe for this generated ADO review.</p>
          <strong>Select a mode:</strong>
          <div class="present-launch-actions">
            <a class="secondary-button" href="/ado-present/${encodeURIComponent(jobId)}?vibe=light" target="_blank" rel="noreferrer">Light</a>
            <a class="secondary-button" href="/ado-present/${encodeURIComponent(jobId)}?vibe=blue" target="_blank" rel="noreferrer">Blue</a>
            <a class="secondary-button strong" href="/ado-present/${encodeURIComponent(jobId)}?vibe=prismatic" target="_blank" rel="noreferrer">Prismatic</a>
          </div>
        </div>
      </section>
    `
  });
}

function renderSavedReviewsPage({ reviews = [] } = {}) {
  const reviewCards =
    reviews.length > 0
      ? `<div class="saved-review-grid">
          ${reviews
            .map((review) => {
              const result = review.result || {};
              const iteration = result.iteration || {};
              const totals = (result.metrics && result.metrics.totals) || {};
              const reviewId = review.id || "";

              return `
                <article class="saved-review-card">
                  <div>
                    <span>${escapeHtml(formatDateOnly(iteration.startDate))} to ${escapeHtml(formatDateOnly(iteration.finishDate))}</span>
                    <h2>${escapeHtml(iteration.name || review.sprintName || "Saved sprint review")}</h2>
                    <p>${escapeHtml(result.team || review.team || "Team not available")}</p>
                  </div>
                  <div class="saved-review-stats">
                    <div><span>Completed</span><strong>${escapeHtml(formatNumber(totals.completedItems || 0))}</strong></div>
                    <div><span>Points</span><strong>${escapeHtml(formatNumber(totals.deliveredStoryPoints || 0))}</strong></div>
                    <div><span>Updated</span><strong>${escapeHtml(formatSavedTimestamp(review.updatedAt || review.createdAt))}</strong></div>
                  </div>
                  <div class="saved-review-actions">
                    <a class="primary-button" href="/reviews/${encodeURIComponent(reviewId)}">Open</a>
                    <a class="secondary-button" href="/reviews/${encodeURIComponent(reviewId)}/edit">Edit wording</a>
                    <a class="ghost-button" href="/reviews/${encodeURIComponent(reviewId)}/present?vibe=prismatic" target="_blank" rel="noreferrer">Present</a>
                  </div>
                </article>
              `;
            })
            .join("")}
        </div>`
      : `<section class="result-card saved-empty-card">
          <div class="success-orb calm">save</div>
          <div class="eyebrow">Saved Reviews</div>
          <h1>No saved reviews yet.</h1>
          <p class="lede">Generate a sprint review from the builder and Scrum Studio will save an editable local copy here.</p>
          <div class="result-actions">
            <a class="primary-button" href="/ado-admin">Open Review Builder</a>
          </div>
        </section>`;

  return renderPage({
    title: "Scrum Studio - Saved Reviews",
    bodyClass: "ado-page saved-reviews-page",
    content: `
      <div class="studio-return-row">
        <a class="ghost-button" href="/">Home</a>
        <a class="ghost-button" href="/ado-admin">Review Builder</a>
      </div>
      <section class="review-flow-heading saved-library-heading">
        <div>
          <div class="eyebrow">Review Library</div>
          <h1>Saved sprint reviews</h1>
          <p class="lede">Reopen a generated review, adjust wording or story grouping, and regenerate the local HTML report and Presentation Mode without re-entering a PAT.</p>
        </div>
      </section>
      ${reviewCards}
    `
  });
}

function renderSavedReviewReadyPage({ review }) {
  const result = review.result || {};
  const iteration = result.iteration || {};
  const metrics = result.metrics || {};
  const warnings = filterContributorWarnings(result.warnings || [], metrics.contributors);
  const warningHtml =
    warnings.length > 0
      ? `<div class="alert alert-warn"><strong>Review note:</strong><ul>${warnings
          .map((warning) => `<li>${escapeHtml(warning)}</li>`)
          .join("")}</ul></div>`
      : "";

  return renderPage({
    title: "Scrum Studio - Saved Review",
    bodyClass: "result-page ado-page",
    content: `
      <section class="result-card ado-report-ready-card">
        <div class="success-orb">saved</div>
        <div class="eyebrow">Saved Review</div>
        <h1>${escapeHtml(iteration.name || review.sprintName || "This review")} is ready to reuse.</h1>
        <p class="lede">This durable local copy uses the saved ADO snapshot and approved narrative. Edit wording any time, or refresh ADO facts with a one-time PAT.</p>
        ${warningHtml}
        <div class="result-actions">
          <a class="primary-button" href="/reviews/${encodeURIComponent(review.id)}/download-html">Download HTML</a>
          <a class="secondary-button strong" href="/reviews/${encodeURIComponent(review.id)}/preview" target="_blank" rel="noreferrer">Open HTML report</a>
          <a class="secondary-button" href="/reviews/${encodeURIComponent(review.id)}/edit">Edit wording</a>
          <a class="ghost-button" href="/reviews">Saved reviews</a>
        </div>
        <div class="present-launch">
          <span>Presentation Mode</span>
          <p>These links are durable while this saved review remains on the machine.</p>
          <strong>Select a mode:</strong>
          <div class="present-launch-actions">
            <a class="secondary-button" href="/reviews/${encodeURIComponent(review.id)}/present?vibe=light" target="_blank" rel="noreferrer">Light</a>
            <a class="secondary-button" href="/reviews/${encodeURIComponent(review.id)}/present?vibe=blue" target="_blank" rel="noreferrer">Blue</a>
            <a class="secondary-button strong" href="/reviews/${encodeURIComponent(review.id)}/present?vibe=prismatic" target="_blank" rel="noreferrer">Prismatic</a>
          </div>
        </div>
        <div class="mini-summary">
          <div><span>Team</span><strong>${escapeHtml(result.team || review.team || "Not available")}</strong></div>
          <div><span>Work areas</span><strong>${escapeHtml(areaPathDisplay(getSavedReviewAreaPaths(review, result)))}</strong></div>
          <div><span>Dates</span><strong>${escapeHtml(formatDateOnly(iteration.startDate))} to ${escapeHtml(formatDateOnly(iteration.finishDate))}</strong></div>
          <div><span>Updated</span><strong>${escapeHtml(formatSavedTimestamp(review.updatedAt || review.createdAt))}</strong></div>
        </div>
      </section>
    `
  });
}

function renderSavedReviewEditPage({ review, error = null, notice = "" } = {}) {
  const draft = buildDraftFromSavedReview(review);
  const errorHtml = error
    ? `<div class="alert alert-error"><strong>Saved review:</strong> ${escapeHtml(error.message || error)}${
        error.detail ? `<small>${escapeHtml(error.detail)}</small>` : ""
      }</div>`
    : "";
  const noticeHtml = notice
    ? `<div class="alert alert-good"><strong>Updated.</strong> ${escapeHtml(notice)}</div>`
    : "";

  return renderPage({
    title: "Scrum Studio - Edit Saved Review",
    bodyClass: "ado-page builder-page",
    content: `
      <div class="studio-return-row">
        <a class="ghost-button" href="/">Home</a>
        <a class="ghost-button" href="/reviews">Saved reviews</a>
        <a class="ghost-button" href="/reviews/${encodeURIComponent(review.id)}">Review ready</a>
      </div>
      ${errorHtml}
      ${noticeHtml}
      ${renderAdoReviewBuilderContent({
        draft,
        narrative: review.narrative || {},
        action: `/reviews/${encodeURIComponent(review.id)}/update`,
        submitLabel: "Update Saved Review",
        backHref: `/reviews/${encodeURIComponent(review.id)}`,
        backLabel: "Back to saved review",
        savedMode: true
      })}
      <section class="ado-form-card saved-refresh-card">
        <div class="form-heading">
          <span>Optional refresh</span>
          <strong>Refresh ADO facts with a one-time PAT</strong>
        </div>
        <p class="saved-refresh-copy">Use this only when you want the saved snapshot to pull current Azure DevOps facts again. The PAT is used for this request and is not written to disk.</p>
        <form action="/reviews/${encodeURIComponent(review.id)}/refresh" method="post" autocomplete="off">
          <label class="field-group" for="pat">
            <span>Azure DevOps PAT</span>
            <input class="text-input" id="pat" name="pat" type="password" required placeholder="Paste PAT for refresh only" autocomplete="off">
          </label>
          <button class="secondary-button strong" type="submit">Refresh ADO snapshot</button>
        </form>
      </section>
    `
  });
}

function renderAdoTestPage({ values = {}, result = null, error = null } = {}) {
  const teamValue = values.team || defaultAdoTeam;
  const sprintValue = values.sprint || "37";
  const errorHtml = error
    ? `<div class="alert alert-error"><strong>ADO test stopped:</strong> ${escapeHtml(error.message)}${
        error.detail ? `<small>${escapeHtml(error.detail)}</small>` : ""
      }</div>`
    : "";

  const resultHtml = result
    ? `
      <section class="ado-results" aria-label="ADO feasibility test results">
        <div class="result-ribbon">
          <div>
            <span>Feasibility result</span>
            <strong>ADO burndown data is reachable.</strong>
          </div>
          <a class="ghost-button" href="/ado-test">Run another test</a>
        </div>

        ${
          result.warnings.length > 0
            ? `<div class="alert alert-warn"><strong>Review note:</strong><ul>${result.warnings
                .map((warning) => `<li>${escapeHtml(warning)}</li>`)
                .join("")}</ul></div>`
            : `<div class="alert alert-good"><strong>Clean signal.</strong> REST, Analytics, and WorkItemSnapshot all returned usable data.</div>`
        }

        <div class="diagnostic-grid">
          <div class="stat-card good">
            <span>REST connection</span>
            <strong>Connected</strong>
            <small>${escapeHtml(result.iterationCount)} team iterations found</small>
          </div>
          <div class="stat-card good">
            <span>Analytics</span>
            <strong>${result.metadata.hasWorkItemSnapshot ? "Snapshot ready" : "Metadata reachable"}</strong>
            <small>Status ${escapeHtml(result.metadata.status)}</small>
          </div>
          <div class="stat-card">
            <span>Burndown rows</span>
            <strong>${escapeHtml(result.burndown.rowCount)}</strong>
            <small>${escapeHtml(result.burndown.dayCount)} sprint days represented</small>
          </div>
          <div class="stat-card">
            <span>Story points found</span>
            <strong>${escapeHtml(formatNumber(result.burndown.maxStoryPoints))}</strong>
            <small>Max daily total from grouped rows</small>
          </div>
        </div>

        <div class="ado-context-grid">
          <div>
            <span>Team</span>
            <strong>${escapeHtml(result.team)}</strong>
          </div>
          <div>
            <span>Resolved sprint</span>
            <strong>${escapeHtml(result.iteration.name)}</strong>
          </div>
          <div>
            <span>Iteration path</span>
            <strong>${escapeHtml(result.iteration.path)}</strong>
          </div>
          <div>
            <span>Dates</span>
            <strong>${escapeHtml(formatDateOnly(result.iteration.startDate))} to ${escapeHtml(formatDateOnly(result.iteration.finishDate))}</strong>
          </div>
          <div>
            <span>Current sprint work items</span>
            <strong>${escapeHtml(result.workItems.count)}</strong>
            <small>${escapeHtml(result.workItems.source)}</small>
          </div>
          <div>
            <span>ADO source</span>
            <strong>${escapeHtml(result.config.org)} / ${escapeHtml(result.config.project)}</strong>
          </div>
        </div>

        <section class="data-preview">
          <div>
            <span>Sample grouped rows</span>
            <h2>Daily story snapshots by state</h2>
          </div>
          ${renderAdoRows(result.burndown.sampleRows)}
        </section>

        ${
          result.workItems.items.length > 0
            ? `<section class="data-preview compact">
                <div>
                  <span>Sample work items</span>
                  <h2>Stories Scrum Studio can read next</h2>
                </div>
                ${renderAdoWorkItems(result.workItems.items)}
              </section>`
            : ""
        }
      </section>
    `
    : "";

  return renderPage({
    title: "Scrum Studio - ADO Feasibility Test",
    bodyClass: "ado-page",
    content: `
      <section class="ado-hero">
        <div class="ado-copy">
          <div class="eyebrow">Phase 1 data lab</div>
          <h1>Check whether Scrum Studio can read your sprint facts.</h1>
          <p class="lede">Use a short-lived Azure DevOps PAT to test team iterations, Analytics metadata, WorkItemSnapshot burndown rows, and current sprint work items.</p>
          <div class="ado-northstar">
            <strong>North Star</strong>
            <p>ADO provides facts. Scrum Studio calculates metrics. The scrum master edits and approves the final story.</p>
          </div>
        </div>

        <form class="ado-form-card" action="/ado-test" method="post" autocomplete="off">
          <div class="form-heading">
            <span>Project</span>
            <strong>${escapeHtml(adoConfig.org)} / ${escapeHtml(adoConfig.project)}</strong>
          </div>
          ${errorHtml}
          <label class="field-group" for="pat">
            <span>Azure DevOps PAT</span>
            <input class="text-input" id="pat" name="pat" type="password" required placeholder="Paste PAT for this test only" autocomplete="off">
            <small>The token is used only for this request. Scrum Studio does not save it.</small>
          </label>
          <label class="field-group" for="team">
            <span>Team</span>
            <input class="text-input" id="team" name="team" type="text" required value="${escapeHtml(teamValue)}">
          </label>
          <label class="field-group" for="sprint">
            <span>Sprint / iteration</span>
            <input class="text-input" id="sprint" name="sprint" type="text" required value="${escapeHtml(sprintValue)}" placeholder="37 or full iteration path">
            <small>Enter a sprint number like 37, or paste the full iteration path.</small>
          </label>
          <button class="primary-button" type="submit">Run feasibility test</button>
          <a class="ghost-button full-width" href="/">Back Home</a>
        </form>
      </section>
      ${resultHtml}
    `
  });
}

function renderAdoStatusSummary(result) {
  if (!result) {
    return "";
  }

  return `
    <section class="ado-results" aria-label="ADO imported data preview">
      <div class="result-ribbon">
        <div>
          <span>ADO preview</span>
          <strong>${escapeHtml(result.iteration.name)} is ready for report intelligence.</strong>
        </div>
        <a class="ghost-button" href="/ado-admin">Choose another team</a>
      </div>

      ${
        result.warnings.length > 0
          ? `<div class="alert alert-warn"><strong>Review note:</strong><ul>${result.warnings
              .map((warning) => `<li>${escapeHtml(warning)}</li>`)
              .join("")}</ul></div>`
          : `<div class="alert alert-good"><strong>Clean signal.</strong> REST, Analytics, WorkItemSnapshot, and work items are all readable.</div>`
      }

      <section class="insight-section">
        <div>
          <span>Agile Metrics</span>
        </div>
        ${renderSprintHealthCards(result.metrics && result.metrics.sprintHealthCards)}
      </section>

      <section class="insight-section burndown-focus-section">
        <div>
          <span>Burndown Chart</span>
        </div>
        ${renderBurndownChart(result.metrics && result.metrics.selectedBurndown)}
      </section>

      <section class="insight-section">
        <div>
          <span>Velocity</span>
          <h2>Last 3 completed sprints</h2>
        </div>
        ${renderVelocityBars(result.metrics && result.metrics.velocity)}
      </section>

      <section class="insight-section">
        <div>
          <span>Stories to review</span>
          <h2>Completed work Scrum Studio can summarize next</h2>
        </div>
        <div class="story-list-grid completed-only">
          ${renderMetricStoryList(
            "Completed items",
            result.metrics && result.metrics.items ? result.metrics.items.completed : [],
            "No completed stories or bugs were found for this sprint."
          )}
        </div>
      </section>

      <div class="ado-builder-launch">
        <div>
          <span>Next step</span>
          <strong>Build the editable sprint review</strong>
          <p>Use these ADO facts, select real stories, add business value, and generate the report, PDF, and Presentation Mode.</p>
        </div>
        <form action="/ado-admin/review" method="post">
          <input type="hidden" name="team" value="${escapeHtml(result.team)}">
          ${renderAreaPathHiddenInputs(result.areaPaths, result.areaPath)}
          <input type="hidden" name="sprint" value="${escapeHtml(result.iteration.path)}">
          <button class="primary-button" type="submit">Build sprint review</button>
        </form>
      </div>

      <div class="ado-context-grid">
        <div>
          <span>Team</span>
          <strong>${escapeHtml(result.team)}</strong>
          <small>${escapeHtml(result.iterationCount)} iterations visible</small>
        </div>
        <div>
          <span>Work areas</span>
          <strong>${escapeHtml(areaPathDisplay(normalizeAreaPathList(result.areaPaths, result.areaPath)))}</strong>
        </div>
        <div>
          <span>Iteration path</span>
          <strong>${escapeHtml(result.iteration.path)}</strong>
        </div>
        <div>
          <span>Dates</span>
          <strong>${escapeHtml(formatDateOnly(result.iteration.startDate))} to ${escapeHtml(formatDateOnly(result.iteration.finishDate))}</strong>
        </div>
        <div>
          <span>Current sprint work items</span>
          <strong>${escapeHtml(result.workItems.count)}</strong>
          <small>${escapeHtml(result.workItems.source)}</small>
        </div>
        <div>
          <span>Analytics</span>
          <strong>${result.metadata.hasWorkItemSnapshot ? "Snapshot ready" : "Reachable"}</strong>
          <small>Status ${escapeHtml(result.metadata.status)}</small>
        </div>
        <div>
          <span>Raw burndown rows</span>
          <strong>${escapeHtml(result.burndown.rowCount)}</strong>
          <small>${escapeHtml(result.burndown.dayCount)} sprint days represented</small>
        </div>
      </div>

      <section class="data-preview">
        <div>
          <span>Sample grouped rows</span>
          <h2>Daily story snapshots by state</h2>
        </div>
        ${renderAdoRows(result.burndown.sampleRows)}
      </section>

      ${
        result.workItems.items.length > 0
          ? `<section class="data-preview compact">
              <div>
                <span>Sample work items</span>
                <h2>Stories Scrum Studio can read next</h2>
              </div>
              ${renderAdoWorkItems(result.workItems.items)}
            </section>`
          : ""
      }
    </section>
  `;
}

function renderTeamOptions(teams, selectedTeam) {
  const selected = String(selectedTeam || "");
  const options = teams
    .map(
      (team) =>
        `<option value="${escapeHtml(team.name)}"${team.name === selected ? " selected" : ""}>${escapeHtml(team.name)}</option>`
    )
    .join("");

  return `<option value="">Select a team</option>${options}`;
}

function renderIterationOptions(iterations, selectedSprint) {
  const selected = String(selectedSprint || "");

  return iterations
    .map((iteration) => {
      const start = formatDateOnly(iteration.attributes && iteration.attributes.startDate);
      const finish = formatDateOnly(iteration.attributes && iteration.attributes.finishDate);
      const label = `${iteration.name || getSprintLabel(iteration.path)} (${start} to ${finish})`;
      const value = iteration.path || iteration.name || "";
      const isSelected = value === selected || iteration.name === selected;

      return `<option value="${escapeHtml(value)}"${isSelected ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function renderAreaOptions(areaPaths, selectedAreaPaths) {
  const selected = new Set(normalizeAreaPathList(selectedAreaPaths));
  const options = (areaPaths || [])
    .map((area) => {
      const value = area.value || "";

      return `<option value="${escapeHtml(value)}"${selected.has(value) ? " selected" : ""}>${escapeHtml(value)}</option>`;
    })
    .join("");

  return options;
}

function resolveSelectedAreaPaths(areaPaths, selectedAreaPaths, defaultAreaPath = "") {
  const selected = normalizeAreaPathList(selectedAreaPaths);
  const areas = areaPaths || [];
  const knownValues = new Set(areas.map((area) => area.value).filter(Boolean));
  const validSelected = selected.filter((areaPath) => knownValues.has(areaPath));

  if (validSelected.length > 0) {
    return validSelected;
  }

  if (selected.length > 0 && areas.length === 0) {
    return selected;
  }

  if (defaultAreaPath && areas.some((area) => area.value === defaultAreaPath)) {
    return [defaultAreaPath];
  }

  return areas[0] && areas[0].value ? [areas[0].value] : selected;
}

function formatIterationForClient(iteration) {
  return {
    name: iteration.name || getSprintLabel(iteration.path),
    path: iteration.path || "",
    startDate: (iteration.attributes && iteration.attributes.startDate) || iteration.startDate || "",
    finishDate: (iteration.attributes && iteration.attributes.finishDate) || iteration.finishDate || "",
    timeFrame: (iteration.attributes && iteration.attributes.timeFrame) || iteration.timeFrame || ""
  };
}

function getSprintLabel(iterationPath) {
  const parts = String(iterationPath || "").split("\\").filter(Boolean);
  return parts[parts.length - 1] || "Sprint";
}

function renderAdoAdminConnectPage({ error = null } = {}) {
  const errorHtml = error
    ? `<div class="alert alert-error"><strong>Connection:</strong> ${escapeHtml(error.message)}${
        error.detail ? `<small>${escapeHtml(error.detail)}</small>` : ""
      }</div>`
    : "";

  return renderPage({
    title: "Scrum Studio - Start Review",
    bodyClass: "ado-page guided-page",
    content: `
      <div class="studio-return-row">
        <a class="ghost-button" href="/">Home</a>
        <a class="ghost-button" href="/reviews">Saved reviews</a>
      </div>
      <section class="ado-hero guided-auth">
        <div class="ado-copy">
          <div class="eyebrow">Review Builder</div>
          <h1>Start your sprint review</h1>
          <p class="lede">Use a temporary Azure DevOps PAT, then choose the sprint you want to turn into a polished review.</p>
          <div class="ado-northstar">
            <strong>Secure session</strong>
            <p>Your PAT is kept in memory for this browser session only.</p>
          </div>
        </div>

        <form class="ado-form-card" action="/ado-admin/connect" method="post" autocomplete="off">
          <div class="form-heading">
            <span>Connect</span>
            <strong>Unlock sprint data</strong>
          </div>
          ${errorHtml}
          <label class="field-group" for="pat">
            <span>Azure DevOps PAT</span>
            <input class="text-input" id="pat" name="pat" type="password" required placeholder="Paste PAT" autocomplete="off">
            <small>Read access to teams, iterations, work items, and Analytics.</small>
          </label>
          <button class="primary-button" type="submit">Continue</button>
        </form>
      </section>
    `
  });
}

function renderAdoAdminPage({
  teams = [],
  selectedTeam = "",
  areaPaths = [],
  selectedAreaPaths = [],
  iterations = [],
  result = null,
  error = null
} = {}) {
  const errorHtml = error
      ? `<div class="alert alert-error"><strong>Review Builder note:</strong> ${escapeHtml(error.message)}${
        error.detail ? `<small>${escapeHtml(error.detail)}</small>` : ""
      }</div>`
    : "";

  const initialScope = selectedTeam
    ? {
        team: selectedTeam,
        areaPaths,
        defaultAreaPaths: normalizeAreaPathList(selectedAreaPaths),
        defaultAreaPath: primaryAreaPath(selectedAreaPaths),
        iterations: iterations.map(formatIterationForClient)
      }
    : null;

  return renderPage({
    title: "Scrum Studio - Choose Review",
    bodyClass: "ado-page guided-page",
    content: `
      <section class="review-flow-shell">
        <div class="review-flow-heading">
          <div>
            <div class="eyebrow">Review Builder</div>
            <h1>Choose your review</h1>
            <p class="lede">Pick the team and sprint. Scrum Studio will pull the facts and open the builder.</p>
          </div>
          <div class="review-flow-actions">
            <a class="ghost-button" href="/">Home</a>
            <a class="ghost-button" href="/reviews">Saved reviews</a>
            <form action="/ado-admin/disconnect" method="post">
              <button class="ghost-button" type="submit">Disconnect</button>
            </form>
          </div>
        </div>

        <form class="review-flow-card" action="/ado-admin/review" method="post" data-review-flow>
          ${errorHtml}
          <div class="flow-step is-active">
            <span class="flow-step-number">1</span>
            <div>
              <label class="field-group" for="team">
                <span>Choose team</span>
                <select class="text-input" id="team" name="team" required data-team-select>
                  ${renderTeamOptions(teams, selectedTeam)}
                </select>
                <small>Choose the team you are reviewing.</small>
              </label>
            </div>
          </div>

          <div class="scope-status" data-scope-status>${selectedTeam ? "Team scope loaded." : "Team selection unlocks sprint details."}</div>

          <div class="scope-panel${selectedTeam ? " is-open" : ""}" data-scope-details${selectedTeam ? "" : " aria-hidden=\"true\""}>
            <div class="flow-step">
              <span class="flow-step-number">2</span>
              <div class="scope-grid">
                <label class="field-group" for="sprint">
                  <span>Choose sprint</span>
                  <select class="text-input" id="sprint" name="sprint" required data-sprint-select${selectedTeam ? "" : " disabled"}>
                    ${renderIterationOptions(iterations)}
                  </select>
                  <small>Choose the sprint to review.</small>
                </label>
                <label class="field-group" for="areaPaths">
                  <span>Work areas</span>
                  <select class="text-input area-multi-select" id="areaPaths" name="areaPaths" multiple required data-area-select${selectedTeam ? "" : " disabled"}>
                    ${renderAreaOptions(areaPaths, selectedAreaPaths)}
                  </select>
                  <small>Choose one or more value areas for this combined review. Use Ctrl or Shift to select more than one.</small>
                </label>
              </div>
            </div>

            <div class="flow-step build-step">
              <span class="flow-step-number">3</span>
              <div>
                <strong>Review builder</strong>
                <p data-build-copy>Choose sprint and work areas. Scrum Studio will load the builder below.</p>
              </div>
            </div>
          </div>

          <noscript>
            <div class="alert alert-warn"><strong>JavaScript required:</strong> Enable JavaScript to load area and sprint choices without leaving this page.</div>
          </noscript>
        </form>

        <section class="inline-builder-shell" data-inline-builder aria-live="polite"></section>
      </section>

      <script>
        (function () {
          var initialScope = ${safeJsonForScript(initialScope)};
          var form = document.querySelector("[data-review-flow]");
          if (!form) return;

          var teamSelect = form.querySelector("[data-team-select]");
          var areaSelect = form.querySelector("[data-area-select]");
          var sprintSelect = form.querySelector("[data-sprint-select]");
          var details = form.querySelector("[data-scope-details]");
          var status = form.querySelector("[data-scope-status]");
          var buildCopy = form.querySelector("[data-build-copy]");
          var builderMount = document.querySelector("[data-inline-builder]");
          var lastBuilderKey = "";
          form.classList.add("is-inline-builder-enabled");

          function setStatus(message, tone) {
            status.textContent = message;
            status.className = "scope-status" + (tone ? " " + tone : "");
          }

          function formatDate(value) {
            var raw = String(value || "");
            var match = raw.match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
            return match ? Number(match[2]) + "/" + Number(match[3]) + "/" + match[1].slice(2) : raw;
          }

          function setOptions(select, items, placeholder, getValue, getLabel, selectedValue) {
            select.innerHTML = "";
            var selectedValues = Array.isArray(selectedValue)
              ? selectedValue.map(String)
              : selectedValue
                ? [String(selectedValue)]
                : [];

            if (!select.multiple) {
              var placeholderOption = document.createElement("option");
              placeholderOption.value = "";
              placeholderOption.textContent = placeholder;
              select.appendChild(placeholderOption);
            }

            items.forEach(function (item) {
              var option = document.createElement("option");
              option.value = getValue(item);
              option.textContent = getLabel(item);
              if (selectedValues.indexOf(option.value) !== -1) {
                option.selected = true;
              }
              select.appendChild(option);
            });
          }

          function getSelectedAreaPaths() {
            return Array.prototype.slice.call(areaSelect.selectedOptions || [])
              .map(function (option) { return option.value; })
              .filter(Boolean);
          }

          function updateBuildState() {
            var ready = Boolean(teamSelect.value && getSelectedAreaPaths().length > 0 && sprintSelect.value);
            if (buildCopy) {
              buildCopy.textContent = ready
                ? "Scrum Studio is loading the review builder below."
                : "Choose sprint and work areas. Scrum Studio will load the builder below.";
            }
          }

          function setBuilderMessage(message, tone) {
            if (!builderMount) return;
            builderMount.innerHTML = "";
            var box = document.createElement("div");
            box.className = "inline-builder-message" + (tone ? " " + tone : "");
            box.textContent = message;
            builderMount.appendChild(box);
          }

          function clearBuilder() {
            lastBuilderKey = "";
            if (builderMount) {
              builderMount.innerHTML = "";
            }
          }

          function initStoryPickers(root) {
            root.querySelectorAll("[data-story-picker]").forEach(function (picker) {
              var total = picker.querySelector("[data-picker-total]");
              var inputs = Array.prototype.slice.call(picker.querySelectorAll("input[type='checkbox']"));

              function updateTotal() {
                var selected = inputs.filter(function (input) { return input.checked; });
                var points = selected.reduce(function (sum, input) {
                  var value = Number(input.getAttribute("data-points") || 0);
                  return sum + (Number.isFinite(value) ? value : 0);
                }, 0);

                if (total) {
                  total.textContent = selected.length + " selected / " + points.toLocaleString("en-US", { maximumFractionDigits: 1 }) + " pts";
                }
              }

              picker.addEventListener("change", updateTotal);
              updateTotal();
            });
          }

          async function loadInlineBuilder(force) {
            if (!builderMount) return;

            var selectedAreaPaths = getSelectedAreaPaths();
            var ready = Boolean(teamSelect.value && selectedAreaPaths.length > 0 && sprintSelect.value);
            if (!ready) {
              clearBuilder();
              return;
            }

            var key = [teamSelect.value, selectedAreaPaths.join("::"), sprintSelect.value].join("||");
            if (!force && key === lastBuilderKey && builderMount.innerHTML.trim()) {
              return;
            }

            lastBuilderKey = key;
            setStatus("Building review...", "good");
            setBuilderMessage("Loading stories, metrics, and next-sprint context...");

            var body = new URLSearchParams();
            body.set("team", teamSelect.value);
            body.set("areaPath", selectedAreaPaths[0] || "");
            selectedAreaPaths.forEach(function (areaPath) {
              body.append("areaPaths", areaPath);
            });
            body.set("sprint", sprintSelect.value);
            body.set("inline", "1");

            try {
              var response = await fetch("/ado-admin/review?partial=1", {
                method: "POST",
                headers: {
                  Accept: "text/html",
                  "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
                },
                body: body.toString()
              });
              var html = await response.text();

              if (key !== [teamSelect.value, getSelectedAreaPaths().join("::"), sprintSelect.value].join("||")) {
                return;
              }

              builderMount.innerHTML = html;
              if (window.ScrumStudioReviewBuilder) {
                window.ScrumStudioReviewBuilder.init(builderMount);
              } else {
                initStoryPickers(builderMount);
              }

              if (!response.ok) {
                lastBuilderKey = "";
                setStatus("Could not build review.", "error");
                return;
              }

              setStatus("Builder ready below.", "good");
            } catch (error) {
              lastBuilderKey = "";
              setStatus(error.message, "error");
              setBuilderMessage(error.message, "error");
            }
          }

          function resetScope(message) {
            setOptions(areaSelect, [], "Select one or more area paths", function () { return ""; }, function () { return ""; });
            setOptions(sprintSelect, [], "Select a sprint", function () { return ""; }, function () { return ""; });
            areaSelect.disabled = true;
            sprintSelect.disabled = true;
            details.classList.remove("is-open");
            details.setAttribute("aria-hidden", "true");
            setStatus(message || "Team selection unlocks sprint details.");
            clearBuilder();
            updateBuildState();
          }

          function applyScope(data) {
            var areas = Array.isArray(data.areaPaths) ? data.areaPaths : [];
            var iterations = Array.isArray(data.iterations) ? data.iterations : [];

            setOptions(
              areaSelect,
              areas,
              "Select one or more area paths",
              function (area) { return area.value || ""; },
              function (area) { return area.value || ""; },
              Array.isArray(data.defaultAreaPaths) && data.defaultAreaPaths.length > 0
                ? data.defaultAreaPaths
                : data.defaultAreaPath
                  ? [data.defaultAreaPath]
                  : []
            );
            setOptions(
              sprintSelect,
              iterations,
              "Select a sprint",
              function (iteration) { return iteration.path || iteration.name || ""; },
              function (iteration) {
                var dateRange = iteration.startDate && iteration.finishDate ? " (" + formatDate(iteration.startDate) + " to " + formatDate(iteration.finishDate) + ")" : "";
                return (iteration.name || iteration.path || "Sprint") + dateRange;
              },
              ""
            );

            areaSelect.disabled = areas.length === 0;
            sprintSelect.disabled = iterations.length === 0;
            details.classList.add("is-open");
            details.removeAttribute("aria-hidden");
            setStatus("Sprint details ready.", "good");
            updateBuildState();
          }

          async function loadScope(team) {
            if (!team) {
              resetScope();
              return;
            }

            resetScope("Loading sprint details...");

            try {
              var response = await fetch("/ado-admin/scope?team=" + encodeURIComponent(team), {
                headers: {
                  Accept: "application/json"
                }
              });
              var payload = await response.json();

              if (!response.ok) {
                throw new Error(payload.error || "Could not load sprint details.");
              }

              applyScope(payload);
            } catch (error) {
              resetScope(error.message);
              setStatus(error.message, "error");
            }
          }

          teamSelect.addEventListener("change", function () {
            loadScope(teamSelect.value);
          });
          areaSelect.addEventListener("change", function () {
            updateBuildState();
            loadInlineBuilder();
          });
          sprintSelect.addEventListener("change", function () {
            updateBuildState();
            loadInlineBuilder();
          });
          form.addEventListener("submit", function (event) {
            event.preventDefault();
            loadInlineBuilder(true);
          });

          if (initialScope && teamSelect.value === initialScope.team) {
            applyScope(initialScope);
          } else {
            resetScope();
          }
        })();
      </script>
    `
  });
}

function renderCompletedPresentationItems(items) {
  if (!items || items.length === 0) {
    return `<p class="present-empty">No completed stories or bugs were found for this sprint.</p>`;
  }

  return `
    <div class="present-work-list">
      ${items
        .slice(0, 10)
        .map(
          (item) => `
            <article>
              <span>${escapeHtml(item.type)} ${escapeHtml(item.id)} &middot; ${escapeHtml(item.state)}</span>
              <strong>${escapeHtml(item.title)}</strong>
              ${
                item.storyPoints !== null && item.storyPoints !== undefined
                  ? `<small>${escapeHtml(formatNumber(item.storyPoints))} story points</small>`
                  : ""
              }
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderAdoPresentationDeliverySlide(section, index) {
  return `
    <section class="ado-present-slide">
      <div class="present-card wide narrative-card">
        <span class="present-kicker">${section.priority ? "#1 priority" : `Delivery Update ${index + 1}`}</span>
        <h2>${escapeHtml(section.title || `Delivery update ${index + 1}`)}</h2>
        <div class="present-narrative-grid single delivery-update-layout">
          <div class="present-copy-block">
            ${renderBulletList(section.bullets, "No bullet points were added for this update.")}
            ${
              section.stories && section.stories.length > 0
                ? `<div class="delivery-story-pill">${renderStoryChips(section.stories)}</div>`
                : ""
            }
            ${
              section.businessValue
                ? `<div class="present-business-value"><span>Business Value</span><p>${escapeHtml(section.businessValue)}</p></div>`
                : ""
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderAdoPresentationScreenshotSlide(section) {
  return `
    <section class="ado-present-slide">
      <div class="present-card wide narrative-card screenshot-present-card">
        <span class="present-kicker">Screenshot</span>
        <h2>${escapeHtml(section.title || "Screenshot")}</h2>
        <div class="present-screenshot-layout">
          <div class="present-screenshot-media">
            ${section.imageData ? `<img src="${escapeHtml(section.imageData)}" alt="${escapeHtml(section.title || "Review screenshot")}">` : `<p class="present-empty">No screenshot was added.</p>`}
          </div>
          <div class="present-copy-block">
            ${renderBulletList(section.bullets, "No screenshot notes were added.")}
            ${
              section.businessValue
                ? `<div class="present-business-value"><span>Business Value</span><p>${escapeHtml(section.businessValue)}</p></div>`
                : ""
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderAdoPresentationChallengeSlide(section) {
  return `
    <section class="ado-present-slide">
      <div class="present-card wide narrative-card special-present-card challenge-present-card">
        <span class="present-kicker">Challenge</span>
        <div class="present-special-heading">
          <span aria-hidden="true">${sectionIcon("challenge")}</span>
          <h2>${escapeHtml(section.title || "Challenge")}</h2>
        </div>
        <div class="present-copy-block">
          ${renderBulletList(section.bullets, "No challenge notes were added.")}
          ${
            section.businessValue
              ? `<div class="present-business-value"><span>Response</span><p>${escapeHtml(section.businessValue)}</p></div>`
              : ""
          }
        </div>
      </div>
    </section>
  `;
}

function renderAdoPresentationRiskSlide(section) {
  const severity = riskSeverity(section);

  return `
    <section class="ado-present-slide">
      <div class="present-card wide narrative-card special-present-card risk-present-card severity-${escapeHtml(severity)}">
        <span class="present-kicker">Risk</span>
        <div class="present-special-heading">
          <span aria-hidden="true">${sectionIcon("risk")}</span>
          <h2>${escapeHtml(section.title || "Risk")}</h2>
        </div>
        <div class="present-risk-grid">
          <div class="present-copy-block">
            <p>${escapeHtml(section.description || "No risk description was added.")}</p>
            ${
              section.owner || section.notes
                ? `<p class="present-risk-notes">${escapeHtml([section.owner ? `Owner: ${section.owner}` : "", section.notes || ""].filter(Boolean).join(" - "))}</p>`
                : ""
            }
          </div>
          <div class="present-risk-heat">
            <span>Impact</span><strong>${escapeHtml(riskScaleLabel(section.impact))}</strong>
            <span>Likelihood</span><strong>${escapeHtml(riskScaleLabel(section.likelihood))}</strong>
            <span>ROAM</span><strong>${escapeHtml(roamStatusLabel(section.roam))}</strong>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderAdoPresentationNextStepsSlide(section, nextIteration) {
  return `
    <section class="ado-present-slide">
      <div class="present-card wide narrative-card next-present-card">
        <span class="present-kicker">Looking Ahead</span>
        <h2>${escapeHtml(section.title || (nextIteration && nextIteration.name) || "What is next")}</h2>
        <div class="present-narrative-grid${section.stories && section.stories.length > 0 ? "" : " single"}">
          <div class="present-copy-block">
            ${renderBulletList(section.bullets, "No next-step bullets were added.")}
            ${
              section.businessValue
                ? `<div class="present-business-value"><span>Context</span><p>${escapeHtml(section.businessValue)}</p></div>`
                : ""
            }
          </div>
          ${
            section.stories && section.stories.length > 0
              ? `<div class="present-story-block">
                  <span>${escapeHtml(nextIteration ? nextIteration.name : "Next sprint")} stories</span>
                  ${renderStoryChips(section.stories, "", { preview: true, previewLimit: 4 })}
                </div>`
              : ""
          }
        </div>
      </div>
    </section>
  `;
}

function renderAdoPresentationSectionSlides(sections, nextIteration = null) {
  if (!sections || sections.length === 0) {
    return "";
  }

  return sections
    .map((section, index) => {
      if (section.type === "screenshot") {
        return renderAdoPresentationScreenshotSlide(section);
      }

      if (section.type === "challenge") {
        return renderAdoPresentationChallengeSlide(section);
      }

      if (section.type === "risk") {
        return renderAdoPresentationRiskSlide(section);
      }

      if (section.type === "next_steps") {
        return renderAdoPresentationNextStepsSlide(section, nextIteration);
      }

      if (section.type === "live_demo") {
        return renderAdoPresentationDemoSlide(section);
      }

      return renderAdoPresentationDeliverySlide(section, index);
    })
    .join("");
}

function renderAdoPresentationDemoSlide(demo) {
  if (!demo || !demo.enabled) {
    return "";
  }

  const presenters = Array.isArray(demo.presenters) ? demo.presenters : [];
  const demoTitle = demo.title || "Live Demo";
  const showKicker = demoTitle.trim().toLowerCase() !== "live demo";

  return `
    <section class="ado-present-slide demo-handoff-slide">
      <div class="present-card demo-handoff-card">
        ${showKicker ? `<span class="present-kicker">Live Demo</span>` : ""}
        <h2>${escapeHtml(demoTitle)}</h2>
        ${
          presenters.length > 0
            ? `<div class="demo-presenter-chips">
                ${presenters.map((presenter) => `<span>${escapeHtml(presenter)}</span>`).join("")}
              </div>`
            : ""
        }
        ${demo.note ? `<p>${escapeHtml(demo.note)}</p>` : ""}
      </div>
    </section>
  `;
}

function renderAdoPresentationReadinessAudience(title, audience) {
  if (!audience || !audience.enabled) {
    return "";
  }

  const stories = Array.isArray(audience.stories) ? audience.stories : [];
  const hasStories = stories.length > 0;
  const fallbackMessage =
    audience.message ||
    (title === "Training Environment"
      ? "We have items ready to go into the training environment."
      : "We have items ready to go into UAT.");
  const kicker = hasStories ? title : "Readiness";
  const heading = hasStories ? `${stories.length} item${stories.length === 1 ? "" : "s"} expected` : title;

  return `
    <article class="present-readiness-card${hasStories ? " has-stories" : " is-message-only"}">
      <span>${escapeHtml(kicker)}</span>
      <h3>${escapeHtml(heading)}</h3>
      ${
        hasStories
          ? renderStoryChips(stories, "", { preview: true, previewLimit: 4 })
          : `<div class="present-readiness-message">
              <p>${escapeHtml(fallbackMessage)}</p>
            </div>`
      }
    </article>
  `;
}

function renderAdoPresentationReadinessSlide(readiness) {
  const normalized = normalizeEnvironmentReadiness({ environmentReadiness: readiness });

  if (!environmentReadinessHasContent(normalized)) {
    return "";
  }

  return `
    <section class="ado-present-slide readiness-present-slide">
      <div class="present-card wide narrative-card readiness-present-card">
        <span class="present-kicker">Stakeholder Readiness</span>
        <h2>What this means for you</h2>
        <div class="present-readiness-grid">
          ${renderAdoPresentationReadinessAudience("Training Environment", normalized.training)}
          ${renderAdoPresentationReadinessAudience("UAT", normalized.uat)}
        </div>
      </div>
    </section>
  `;
}

function renderPresentationContributors(contributors) {
  if (!contributors || contributors.length === 0) {
    return "";
  }

  return `
    <div class="present-contributors">
      <span>Sprint contributors</span>
      <div class="present-contributor-list">
        ${contributors.map((name) => `<span>${escapeHtml(name)}</span>`).join("")}
      </div>
    </div>
  `;
}

function renderAdoPresentationPage(report, vibeInput) {
  const result = report.result || report;
  const narrative = report.narrative || null;
  const nextIteration = report.nextIteration || null;
  const metrics = result.metrics || {};
  const vibe = normalizePresentationVibe(vibeInput);
  const completedItems = metrics.items ? metrics.items.completed : [];
  const summary = narrative && narrative.summary ? narrative.summary : defaultSummaryText(result);
  const narrativeSections = narrative ? normalizeNarrativeSections(narrative) : [];
  const presentationBrandRailTop = renderBrandRail({
    mono: true,
    className: "presentation-brand-rail is-top"
  });
  const presentationBrandRailBottom = renderBrandRail({
    mono: true,
    className: "presentation-brand-rail is-bottom"
  });
  const openingRemarksSlide = narrative
    ? `
      <section class="ado-present-slide">
        <div class="present-card narrative-card">
          <span class="present-kicker">Sprint Review</span>
          <h2>${escapeHtml(narrative.openingTitle || "Opening Remarks")}</h2>
          ${narrative.openingSubtitle ? `<p class="present-subtitle">${escapeHtml(narrative.openingSubtitle)}</p>` : ""}
          <p class="present-summary">${escapeHtml(summary)}</p>
        </div>
      </section>
    `
    : "";
  const narrativeSlides = narrative
    ? `
      ${renderAdoPresentationSectionSlides(narrativeSections, nextIteration)}
      ${renderAdoPresentationReadinessSlide(narrative.environmentReadiness)}
    `
    : `
      <section class="ado-present-slide">
        <div class="present-card wide">
          <span class="present-kicker">Delivered Work</span>
          <h2>Completed items ready for review</h2>
          ${renderCompletedPresentationItems(completedItems)}
        </div>
      </section>
    `;
  const closingSlide = narrative
    ? `
      <section class="ado-present-slide closing">
        <div class="present-card questions-card">
          <span class="present-kicker">Open Floor</span>
          <h2>Questions, feedback, and discussion.</h2>
          <p>Use this space to capture stakeholder reactions, follow-ups, risks, and anything the team should carry into the next sprint.</p>
        </div>
        ${presentationBrandRailBottom}
      </section>
    `
    : `
      <section class="ado-present-slide closing">
        <div class="present-card">
          <span class="present-kicker">Next Build Step</span>
          <h2>Turn these facts into an editable sprint review.</h2>
          <p>The next layer should combine these ADO facts with web-form narrative fields for business value, demo focus, and looking ahead.</p>
        </div>
        ${presentationBrandRailBottom}
      </section>
    `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(result.iteration.name)} - ADO Presentation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/ado-present.css?v=18">
</head>
<body class="vibe-${escapeHtml(vibe)}">
  <div class="present-progress" aria-hidden="true"><span></span></div>
  <main class="ado-present-deck" data-deck>
    <section class="ado-present-slide opening">
      ${presentationBrandRailTop}
      <div class="present-card">
        <span class="present-kicker">Sprint Recap</span>
        <h1>${escapeHtml(result.iteration.name)}</h1>
        <p>${escapeHtml(result.team)}</p>
        <dl>
          <div><dt>Dates</dt><dd>${escapeHtml(formatDateOnly(result.iteration.startDate))} to ${escapeHtml(formatDateOnly(result.iteration.finishDate))}</dd></div>
          <div><dt>Work areas</dt><dd>${escapeHtml(areaPathDisplay(normalizeAreaPathList(result.areaPaths, result.areaPath)))}</dd></div>
          <div><dt>Project</dt><dd>${escapeHtml(result.config.project)}</dd></div>
        </dl>
        ${renderPresentationContributors(metrics.contributors)}
      </div>
    </section>

    ${openingRemarksSlide}

    <section class="ado-present-slide">
      <div class="present-card label-only">
        <span class="present-kicker">Agile Metrics</span>
        ${renderSprintHealthCards(metrics.sprintHealthCards)}
      </div>
    </section>

    <section class="ado-present-slide burndown-slide">
      <div class="present-card wide label-only">
        <span class="present-kicker">Burndown Chart</span>
        ${renderBurndownChart(metrics.selectedBurndown)}
      </div>
    </section>

    <section class="ado-present-slide">
      <div class="present-card wide">
        <span class="present-kicker">Velocity</span>
        <h2>Last 3 completed sprints</h2>
        ${renderVelocityBars(metrics.velocity)}
      </div>
    </section>

    ${narrativeSlides}
    ${closingSlide}
  </main>
  <nav class="present-controls" aria-label="Presentation controls">
    <button type="button" data-prev aria-label="Previous slide">&#8592;</button>
    <button type="button" data-next aria-label="Next slide">&#8594;</button>
  </nav>
  <script src="/assets/ado-present.js?v=11"></script>
</body>
</html>`;
}

function renderErrorPage(error) {
  return renderPage({
    title: "Scrum Studio - Needs Attention",
    bodyClass: "error-page",
    content: `
      <section class="result-card error-card">
        <div class="success-orb calm">fix</div>
        <div class="eyebrow">Scrum Studio needs a tweak</div>
        <h1>We could not generate that report yet.</h1>
        <p class="lede">${escapeHtml(error.message || error)}</p>
        <div class="result-actions">
          <a class="primary-button" href="/">Back Home</a>
        </div>
      </section>
    `
  });
}

ensureRuntimeDirs();
cleanupOldJobs();
cleanupAdoSessions();
setInterval(cleanupOldJobs, 60 * 60 * 1000).unref();
setInterval(cleanupAdoSessions, 15 * 60 * 1000).unref();

const storage = multer.diskStorage({
  destination(req, file, callback) {
    const paths = getJobPaths(req.jobId);
    fs.mkdirSync(paths.jobDir, { recursive: true });
    callback(null, paths.jobDir);
  },
  filename(req, file, callback) {
    callback(null, "upload.xlsx");
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: maxUploadBytes,
    files: 1
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname || "").toLowerCase();

    if (extension !== ".xlsx") {
      callback(new Error("Please upload an Excel workbook with the .xlsx extension."));
      return;
    }

    callback(null, true);
  }
});

const reviewBuilderUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxScreenshotBytes,
    files: 20,
    fields: 1200,
    fieldSize: 2 * 1024 * 1024
  },
  fileFilter(req, file, callback) {
    if (!String(file.fieldname || "").startsWith("section_image_")) {
      callback(new Error("Only review section screenshots can be uploaded from the builder."));
      return;
    }

    if (!allowedImageMime(file.mimetype)) {
      callback(new Error("Please upload screenshots as PNG, JPG, GIF, or WebP images."));
      return;
    }

    callback(null, true);
  }
});

async function buildAdoDataPreview({ pat, team, sprint, areaPath = "", areaPaths = [] }) {
  const selectedAreaPaths = normalizeAreaPathList(areaPaths, areaPath);
  const selectedAreaPath = primaryAreaPath(selectedAreaPaths);
  const iterationsResult = await listTeamIterations({
    pat,
    org: adoConfig.org,
    project: adoConfig.project,
    team
  });
  const iteration = resolveIterationInput(sprint, iterationsResult.iterations);
  const metadata = await fetchAnalyticsMetadata({
    pat,
    org: adoConfig.org,
    project: adoConfig.project
  });
  const burndownRows = await queryIterationSnapshotRowsForAreas({
    pat,
    org: adoConfig.org,
    project: adoConfig.project,
    team,
    iterationPath: iteration.path,
    areaPaths: selectedAreaPaths
  });
  const burndown = summarizeBurndownRows(burndownRows);
  const warnings = [];
  const velocityIterations = findVelocityIterations(iterationsResult.iterations, iteration, 3);

  if (!metadata.hasWorkItemSnapshot) {
    warnings.push("Analytics metadata was reachable, but WorkItemSnapshot was not detected in the metadata response.");
  }

  if (burndown.rowCount === 0) {
    warnings.push("No story-point burndown rows were returned. Check whether this sprint has User Story items with Analytics history for the selected team.");
  }

  let workItems = {
    source: "Not checked",
    count: 0,
    items: []
  };

  try {
    workItems = await queryIterationWorkItemsForAreas({
      pat,
      org: adoConfig.org,
      project: adoConfig.project,
      team,
      iterationPath: iteration.path,
      areaPaths: selectedAreaPaths
    });

    if (workItems.warning) {
      warnings.push(workItems.warning);
    }
  } catch (error) {
    warnings.push(`Current sprint work items could not be sampled: ${error.message}`);
  }

  const velocityInputs = [];

  for (const velocityIteration of velocityIterations) {
    try {
      const velocityWorkItems = await queryIterationWorkItemsForAreas({
        pat,
          org: adoConfig.org,
          project: adoConfig.project,
          team,
          iterationPath: velocityIteration.path,
          areaPaths: selectedAreaPaths
        });

      velocityInputs.push({
        iteration: velocityIteration,
        items: velocityWorkItems.items
      });

      if (velocityWorkItems.warning) {
        warnings.push(`${velocityIteration.name}: ${velocityWorkItems.warning}`);
      }
    } catch (error) {
      warnings.push(`${velocityIteration.name || velocityIteration.path} could not be included in velocity: ${error.message}`);
    }
  }

  if (velocityInputs.length === 0) {
    warnings.push("No prior completed sprints were available for the 3-sprint velocity baseline.");
  }

  const metrics = buildAdoMetrics({
    selectedIteration: iteration,
    selectedRows: burndownRows,
    selectedItems: workItems.items,
    previousIteration: null,
    previousRows: null,
    velocityInputs
  });
  const filteredWarnings = filterContributorWarnings(warnings, metrics.contributors);

  return {
    config: adoConfig,
    team,
    areaPath: selectedAreaPath,
    areaPaths: selectedAreaPaths,
    areaPathLabel: areaPathDisplay(selectedAreaPaths),
    iteration,
    iterations: iterationsResult.iterations,
    iterationCount: iterationsResult.count,
    metadata,
    burndown,
    workItems,
    metrics,
    warnings: filteredWarnings
  };
}

function sendLobbyApp(req, res) {
  if (!fs.existsSync(lobbyIndexPath)) {
    res.status(503).send(
      renderErrorPage("The Lobby app has not been built yet. Run npm --prefix apps/lobby install, then npm --prefix apps/lobby run build.")
    );
    return;
  }

  res.sendFile(lobbyIndexPath);
}

const usStateNames = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia"
};

function parseWeatherLocation(value) {
  const raw = String(value || "").trim();
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const stateToken = parts.length > 1 ? parts[1].split(/\s+/)[0].toUpperCase() : "";

  return {
    raw,
    query: parts[0] || raw,
    stateName: usStateNames[stateToken] || parts[1] || ""
  };
}

function selectOpenMeteoLocation(results, stateName) {
  const locations = Array.isArray(results) ? results : [];
  const wantedState = String(stateName || "").toLowerCase();

  if (wantedState) {
    const exactState = locations.find(
      (location) => String(location.admin1 || "").toLowerCase() === wantedState
    );

    if (exactState) {
      return exactState;
    }

    const looseState = locations.find((location) =>
      String(location.admin1 || "").toLowerCase().includes(wantedState)
    );

    if (looseState) {
      return looseState;
    }
  }

  return locations.find((location) => location.country_code === "US") || locations[0] || null;
}

function getWeatherConditionText(code) {
  const weatherCode = Number(code);

  if (weatherCode === 0) return "Clear";
  if ([1, 2].includes(weatherCode)) return "Partly cloudy";
  if (weatherCode === 3) return "Overcast";
  if ([45, 48].includes(weatherCode)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(weatherCode)) return "Drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(weatherCode)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(weatherCode)) return "Snow";
  if ([95, 96, 99].includes(weatherCode)) return "Thunderstorm";

  return "Cloudy";
}

app.use("/assets", express.static(path.join(projectRoot, "public"), { maxAge: 0 }));
if (fs.existsSync(lobbyDistDir)) {
  app.use("/lobby", express.static(lobbyDistDir, { maxAge: 0 }));
}
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.get("/api/weather", async (req, res) => {
  const location = parseWeatherLocation(req.query.location);

  if (!location.raw) {
    res.status(400).json({ error: "Missing location" });
    return;
  }

  try {
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      location.query
    )}&count=10&language=en&format=json`;
    const geocodeResponse = await fetch(geocodeUrl);

    if (!geocodeResponse.ok) {
      res.status(502).json({ error: `Open-Meteo geocoding error (${geocodeResponse.status})` });
      return;
    }

    const geocodeJson = await geocodeResponse.json();
    const matchedLocation = selectOpenMeteoLocation(geocodeJson.results, location.stateName);

    if (!matchedLocation) {
      res.status(404).json({ error: "Weather location not found" });
      return;
    }

    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(
      matchedLocation.latitude
    )}&longitude=${encodeURIComponent(
      matchedLocation.longitude
    )}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`;
    const forecastResponse = await fetch(forecastUrl);

    if (!forecastResponse.ok) {
      res.status(502).json({ error: `Open-Meteo forecast error (${forecastResponse.status})` });
      return;
    }

    const forecastJson = await forecastResponse.json();
    const current = forecastJson.current || {};
    const daily = forecastJson.daily || {};
    const weatherCode = Number(current.weather_code);

    res.json({
      city: matchedLocation.name || "",
      region: matchedLocation.admin1 || matchedLocation.country || "",
      tempF: Math.round(Number(current.temperature_2m) || 0),
      conditionText: getWeatherConditionText(weatherCode),
      weatherCode,
      isDay: current.is_day === 1,
      highF: Math.round(Number(daily.temperature_2m_max && daily.temperature_2m_max[0]) || 0),
      lowF: Math.round(Number(daily.temperature_2m_min && daily.temperature_2m_min[0]) || 0),
      localTime: current.time || "",
      lastUpdated: current.time || ""
    });
  } catch (error) {
    console.error("Weather fetch failed", error);
    res.status(502).json({ error: "Weather unavailable" });
  }
});

app.get(["/lobby", "/lobby/", "/lobby/run", "/lobby/run/"], sendLobbyApp);

app.get("/", (req, res) => {
  res.send(renderHomePage());
});

app.get("/template", (req, res) => {
  res.download(sampleWorkbookPath, "sample-sprint-demo.xlsx");
});

app.get("/ado-test", (req, res) => {
  res.send(renderAdoTestPage());
});

app.post("/ado-test", async (req, res) => {
  const values = {
    team: String(req.body.team || defaultAdoTeam).trim(),
    sprint: String(req.body.sprint || "").trim()
  };
  const pat = String(req.body.pat || "").trim();

  try {
    const result = await buildAdoDataPreview({
      pat,
      team: values.team,
      sprint: values.sprint
    });

    res.send(
      renderAdoTestPage({
        values,
        result
      })
    );
  } catch (error) {
    const formattedError = formatAdoError(error);

    res.status(formattedError.status).send(
      renderAdoTestPage({
        values,
        error: formattedError
      })
    );
  }
});

app.get("/reviews", (req, res) => {
  try {
    res.send(renderSavedReviewsPage({ reviews: listSavedReviews() }));
  } catch (error) {
    res.status(500).send(renderErrorPage(error));
  }
});

app.get("/reviews/:id/edit", (req, res) => {
  try {
    const review = readSavedReview(req.params.id);
    const notice =
      req.query.refreshed === "1"
        ? "ADO facts were refreshed from the saved team and sprint. Existing narrative was preserved where matching story IDs still exist."
        : "";

    res.send(renderSavedReviewEditPage({ review, notice }));
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.post("/reviews/:id/update", reviewBuilderUpload.any(), async (req, res) => {
  try {
    const review = readSavedReview(req.params.id);
    const draft = buildDraftFromSavedReview(review);
    const narrative = parseAdoNarrative(req.body, draft.currentItems, draft.nextWorkItems.items, req.files, review.narrative || {});

    if (!narrative.summary) {
      narrative.summary = defaultSummaryText(draft.result);
    }

    const updatedReview = createSavedReviewFromReport(
      {
        ...review,
        generatedAt: new Date().toISOString().slice(0, 10),
        result: draft.result,
        nextIteration: draft.nextIteration,
        nextWorkItems: draft.nextWorkItems,
        narrative
      },
      review
    );

    await writeSavedReviewArtifacts(updatedReview);
    res.redirect(303, `/reviews/${encodeURIComponent(review.id)}`);
  } catch (error) {
    try {
      const review = readSavedReview(req.params.id);
      res.status(400).send(renderSavedReviewEditPage({ review, error }));
    } catch (readError) {
      res.status(404).send(renderErrorPage(readError));
    }
  }
});

app.post("/reviews/:id/refresh", async (req, res) => {
  let review = null;

  try {
    review = readSavedReview(req.params.id);
    const pat = String(req.body.pat || "").trim();
    const result = review.result || {};
    const iteration = result.iteration || {};
    const team = review.team || result.team || "";
    const sprint = review.sprintPath || iteration.path || iteration.name || "";
    const areaPaths = getSavedReviewAreaPaths(review, result);

    if (!pat) {
      throw {
        status: 400,
        message: "Paste a PAT to refresh ADO facts for this saved review."
      };
    }

    if (!team || !sprint) {
      throw {
        status: 400,
        message: "This saved review is missing the team or sprint path needed to refresh ADO facts."
      };
    }

    const draft = await buildAdoReviewDraft({
      pat,
      team,
      sprint,
      areaPaths
    });
    const narrative = remapNarrativeStories(review.narrative || {}, draft.currentItems, draft.nextWorkItems.items);

    if (!narrative.summary) {
      narrative.summary = defaultSummaryText(draft.result);
    }

    const refreshedReview = createSavedReviewFromReport(
      {
        ...review,
        generatedAt: new Date().toISOString().slice(0, 10),
        result: draft.result,
        nextIteration: draft.nextIteration,
        nextWorkItems: draft.nextWorkItems,
        narrative
      },
      review
    );

    await writeSavedReviewArtifacts(refreshedReview);
    res.redirect(303, `/reviews/${encodeURIComponent(review.id)}/edit?refreshed=1`);
  } catch (error) {
    const formattedError = error && error.status ? formatAdoError(error) : error;

    if (review) {
      res.status((formattedError && formattedError.status) || 400).send(
        renderSavedReviewEditPage({
          review,
          error: formattedError
        })
      );
      return;
    }

    res.status(404).send(renderErrorPage(error));
  }
});

app.get("/reviews/:id/preview", (req, res) => {
  try {
    const review = readSavedReview(req.params.id);
    const paths = getSavedReviewPaths(review.id);

    if (!fs.existsSync(paths.htmlPath)) {
      fs.writeFileSync(paths.htmlPath, renderAdoReportHtml(review), "utf8");
    }

    res.sendFile(paths.htmlPath);
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.get("/reviews/:id/download-html", (req, res) => {
  try {
    const review = readSavedReview(req.params.id);
    const html = renderAdoReportHtml(review);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${getSavedReviewDownloadName(review)}"`);
    res.send(html);
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.get("/reviews/:id/present", (req, res) => {
  try {
    const review = readSavedReview(req.params.id);
    res.send(renderAdoPresentationPage(review, req.query.vibe));
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.get("/reviews/:id", (req, res) => {
  try {
    res.send(renderSavedReviewReadyPage({ review: readSavedReview(req.params.id) }));
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.get("/ado-admin", async (req, res) => {
  const session = getAdoSession(req);

  if (!session) {
    res.send(renderAdoAdminConnectPage());
    return;
  }

  try {
    const selectedTeam = String(req.query.team || "").trim();
    const requestedAreaPaths = normalizeAreaPathList(req.query.areaPaths, req.query.areaPath);
    const teamsResult = await listProjectTeams({
      pat: session.pat,
      org: adoConfig.org,
      project: adoConfig.project
    });
    let iterations = [];
    let areaPaths = [];
    let selectedAreaPaths = requestedAreaPaths;

    if (selectedTeam) {
      const iterationsResult = await listTeamIterations({
        pat: session.pat,
        org: adoConfig.org,
        project: adoConfig.project,
        team: selectedTeam
      });
      const areaPathsResult = await listTeamAreaPaths({
        pat: session.pat,
        org: adoConfig.org,
        project: adoConfig.project,
        team: selectedTeam
      });
      iterations = iterationsResult.iterations;
      areaPaths = areaPathsResult.areas;
      selectedAreaPaths = resolveSelectedAreaPaths(areaPaths, requestedAreaPaths, areaPathsResult.defaultValue);
    }

    res.send(
      renderAdoAdminPage({
        teams: teamsResult.teams,
        selectedTeam,
        areaPaths,
        selectedAreaPaths,
        iterations
      })
    );
  } catch (error) {
    const formattedError = formatAdoError(error);

    res.status(formattedError.status).send(
      renderAdoAdminPage({
        error: formattedError
      })
    );
  }
});

app.post("/ado-admin/connect", async (req, res) => {
  const pat = String(req.body.pat || "").trim();

  try {
    await listProjectTeams({
      pat,
      org: adoConfig.org,
      project: adoConfig.project
    });
    createAdoSession(res, pat);
    res.redirect(303, "/ado-admin");
  } catch (error) {
    const formattedError = formatAdoError(error);

    res.status(formattedError.status).send(
      renderAdoAdminConnectPage({
        error: formattedError
      })
    );
  }
});

app.post("/ado-admin/disconnect", (req, res) => {
  clearAdoSession(req, res);
  res.redirect(303, "/ado-admin");
});

app.get("/ado-admin/scope", async (req, res) => {
  const session = getAdoSession(req);

  if (!session) {
    res.status(401).json({
      error: "Your session expired. Paste your PAT again to continue."
    });
    return;
  }

  const selectedTeam = String(req.query.team || "").trim();

  if (!selectedTeam) {
    res.status(400).json({
      error: "Choose a team first."
    });
    return;
  }

  try {
    const [iterationsResult, areaPathsResult] = await Promise.all([
      listTeamIterations({
        pat: session.pat,
        org: adoConfig.org,
        project: adoConfig.project,
        team: selectedTeam
      }),
      listTeamAreaPaths({
        pat: session.pat,
        org: adoConfig.org,
        project: adoConfig.project,
        team: selectedTeam
      })
    ]);
    const defaultAreaPaths = resolveSelectedAreaPaths(areaPathsResult.areas, [], areaPathsResult.defaultValue);

    res.json({
      team: selectedTeam,
      areaPaths: areaPathsResult.areas,
      defaultAreaPath: primaryAreaPath(defaultAreaPaths),
      defaultAreaPaths,
      iterations: iterationsResult.iterations.map(formatIterationForClient)
    });
  } catch (error) {
    const formattedError = formatAdoError(error);
    res.status(formattedError.status).json({
      error: formattedError.message,
      detail: formattedError.detail
    });
  }
});

async function handleAdoReviewBuilder(req, res) {
  const session = getAdoSession(req);
  const wantsPartial = req.query.partial === "1" || req.body.inline === "1";

  if (!session) {
    if (wantsPartial) {
      res.status(401).send(
        renderAdoReviewBuilderContent({
          inline: true,
          error: {
            message: "Your temporary Scrum Studio session expired. Paste the PAT again to build the sprint review."
          }
        })
      );
      return;
    }

    res.status(401).send(
      renderAdoAdminConnectPage({
        error: {
          message: "Your temporary Scrum Studio session expired. Paste the PAT again to build the sprint review."
        }
      })
    );
    return;
  }

  const selectedTeam = String(req.body.team || "").trim();
  const selectedSprint = String(req.body.sprint || "").trim();
  const selectedAreaPaths = normalizeAreaPathList(req.body.areaPaths, req.body.areaPath);

  try {
    const draft = await buildAdoReviewDraft({
      pat: session.pat,
      team: selectedTeam,
      sprint: selectedSprint,
      areaPaths: selectedAreaPaths
    });

    res.send(wantsPartial ? renderAdoReviewBuilderContent({ draft, inline: true }) : renderAdoReviewBuilderPage({ draft }));
  } catch (error) {
    const formattedError = formatAdoError(error);

    res.status(formattedError.status).send(
      wantsPartial
        ? renderAdoReviewBuilderContent({
            inline: true,
            error: formattedError
          })
        : renderAdoReviewBuilderPage({
            error: formattedError
          })
    );
  }
}

app.post("/ado-admin/preview", handleAdoReviewBuilder);
app.post("/ado-admin/review", handleAdoReviewBuilder);
app.post("/ado-admin/story", handleAdoReviewBuilder);

app.post("/ado-admin/generate-report", createJobId, reviewBuilderUpload.any(), async (req, res) => {
  const session = getAdoSession(req);

  if (!session) {
    removeJob(req.jobId);
    res.status(401).send(
      renderAdoAdminConnectPage({
        error: {
          message: "Your temporary Scrum Studio session expired. Paste the PAT again to generate the ADO report."
        }
      })
    );
    return;
  }

  const selectedTeam = String(req.body.team || "").trim();
  const selectedSprint = String(req.body.sprint || "").trim();
  const selectedAreaPaths = normalizeAreaPathList(req.body.areaPaths, req.body.areaPath);

  try {
    const draft = await buildAdoReviewDraft({
      pat: session.pat,
      team: selectedTeam,
      sprint: selectedSprint,
      areaPaths: selectedAreaPaths
    });
    const narrative = parseAdoNarrative(req.body, draft.currentItems, draft.nextWorkItems.items, req.files);

    if (!narrative.summary) {
      narrative.summary = defaultSummaryText(draft.result);
    }

    const report = {
      generatedAt: new Date().toISOString().slice(0, 10),
      result: draft.result,
      nextIteration: draft.nextIteration,
      nextWorkItems: draft.nextWorkItems,
      narrative
    };
    const paths = getJobPaths(req.jobId);
    const html = renderAdoReportHtml(report);

    fs.mkdirSync(paths.jobDir, { recursive: true });
    fs.writeFileSync(paths.htmlPath, html, "utf8");
    report.pdf = {
      available: false,
      error: ""
    };

    try {
      await exportPdf(paths.htmlPath, paths.pdfPath);
      report.pdf = {
        available: true,
        error: ""
      };
    } catch (pdfError) {
      report.pdf = {
        available: false,
        error: summarizePdfExportError(pdfError)
      };
    }

    const savedReview = createSavedReviewFromReport(report);
    const savedPaths = getSavedReviewPaths(savedReview.id);

    fs.mkdirSync(savedPaths.reviewDir, { recursive: true });
    fs.writeFileSync(savedPaths.htmlPath, renderAdoReportHtml(savedReview), "utf8");

    if (report.pdf.available && fs.existsSync(paths.pdfPath)) {
      fs.copyFileSync(paths.pdfPath, savedPaths.pdfPath);
    }

    writeSavedReviewData(savedReview);
    report.savedReviewId = savedReview.id;

    fs.writeFileSync(paths.adoDataPath, JSON.stringify(report, null, 2), "utf8");
    fs.writeFileSync(
      paths.metaPath,
      JSON.stringify(
        {
          basics: {
            SprintName: `${draft.result.iteration.name} ADO Sprint Report`,
            TeamName: draft.result.team,
            DateRange: `${formatDateOnly(draft.result.iteration.startDate)} to ${formatDateOnly(draft.result.iteration.finishDate)}`,
            TargetRollout: "ADO-powered sprint report",
            FooterText: "Generated by SprintGen"
          },
          warnings: draft.result.warnings || [],
          pdf: report.pdf
        },
        null,
        2
      ),
      "utf8"
    );

    res.redirect(303, `/ado-report/${encodeURIComponent(req.jobId)}`);
  } catch (error) {
    removeJob(req.jobId);

    const formattedError = formatAdoError(error);
    res.status(formattedError.status).send(renderErrorPage(formattedError));
  }
});

app.get("/ado-report/:id", (req, res) => {
  try {
    const paths = getJobPaths(req.params.id);

    if (!fs.existsSync(paths.adoDataPath)) {
      res.status(404).send(renderErrorPage("That ADO report is no longer available. Please generate it again from Scrum Studio."));
      return;
    }

    const report = JSON.parse(fs.readFileSync(paths.adoDataPath, "utf8"));
    res.send(renderAdoReportResultPage({ jobId: req.params.id, report }));
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.post("/ado-admin/presentation", createJobId, async (req, res) => {
  const session = getAdoSession(req);

  if (!session) {
    res.status(401).send(
      renderAdoAdminConnectPage({
        error: {
          message: "Your temporary Scrum Studio session expired. Paste the PAT again to create a presentation."
        }
      })
    );
    return;
  }

  const selectedTeam = String(req.body.team || "").trim();
  const selectedSprint = String(req.body.sprint || "").trim();
  const selectedAreaPaths = normalizeAreaPathList(req.body.areaPaths, req.body.areaPath);

  try {
    const result = await buildAdoDataPreview({
      pat: session.pat,
      team: selectedTeam,
      sprint: selectedSprint,
      areaPaths: selectedAreaPaths
    });
    const paths = getJobPaths(req.jobId);

    fs.mkdirSync(paths.jobDir, { recursive: true });
    fs.writeFileSync(paths.adoDataPath, JSON.stringify(result, null, 2), "utf8");
    res.redirect(303, `/ado-present/${encodeURIComponent(req.jobId)}`);
  } catch (error) {
    removeJob(req.jobId);

    const formattedError = formatAdoError(error);
    res.status(formattedError.status).send(
      renderAdoAdminConnectPage({
        error: formattedError
      })
    );
  }
});

app.get("/ado-present/:id", (req, res) => {
  try {
    const paths = getJobPaths(req.params.id);

    if (!fs.existsSync(paths.adoDataPath)) {
      res.status(404).send(renderErrorPage("That ADO presentation is no longer available. Please create it again from Scrum Studio."));
      return;
    }

    const data = JSON.parse(fs.readFileSync(paths.adoDataPath, "utf8"));
    res.send(renderAdoPresentationPage(data, req.query.vibe));
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.post("/generate", createJobId, upload.single("workbook"), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error("Please choose a .xlsx workbook before generating.");
    }

    const paths = getJobPaths(req.jobId);
    const result = await generateReport({
      workbookPath: paths.uploadPath,
      htmlOutputPath: paths.htmlPath,
      pdfOutputPath: paths.pdfPath
    });

    fs.writeFileSync(
      paths.metaPath,
      JSON.stringify(
        {
          basics: result.data.basics,
          warnings: result.data.warnings
        },
        null,
        2
      ),
      "utf8"
    );

    res.send(renderResultPage({ jobId: req.jobId, data: result.data }));
  } catch (error) {
    removeJob(req.jobId);

    res.status(400).send(renderErrorPage(error));
  }
});

app.get("/preview/:id", (req, res) => {
  try {
    const paths = getJobPaths(req.params.id);

    if (fs.existsSync(paths.adoDataPath)) {
      const report = JSON.parse(fs.readFileSync(paths.adoDataPath, "utf8"));
      res.send(renderAdoReportHtml(report));
      return;
    }

    if (!fs.existsSync(paths.htmlPath)) {
      res.status(404).send(renderErrorPage("That preview is no longer available. Please generate the report again."));
      return;
    }

    res.sendFile(paths.htmlPath);
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.get("/present/:id", (req, res) => {
  try {
    const paths = getJobPaths(req.params.id);

    if (!fs.existsSync(paths.uploadPath)) {
      res.status(404).send(renderErrorPage("That presentation link is no longer available. Please generate the report again."));
      return;
    }

    const result = renderPresentationHtml(paths.uploadPath, req.query.vibe);
    res.send(result.html);
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.get("/download-html/:id", (req, res) => {
  try {
    const paths = getJobPaths(req.params.id);
    let html = "";
    let downloadName = "sprint-review.html";

    if (fs.existsSync(paths.adoDataPath)) {
      const report = JSON.parse(fs.readFileSync(paths.adoDataPath, "utf8"));
      const result = report.result || report;

      html = renderAdoReportHtml(report);
      downloadName = getHtmlDownloadName(result.iteration && result.iteration.name);
    } else if (fs.existsSync(paths.htmlPath)) {
      html = fs.readFileSync(paths.htmlPath, "utf8");

      if (fs.existsSync(paths.metaPath)) {
        const metadata = JSON.parse(fs.readFileSync(paths.metaPath, "utf8"));
        downloadName = getHtmlDownloadName(metadata.basics && metadata.basics.SprintName);
      }
    } else {
      res.status(404).send(renderErrorPage("That HTML report is no longer available. Please generate the report again."));
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    res.send(html);
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.get("/download/:id", (req, res) => {
  try {
    const paths = getJobPaths(req.params.id);

    if (!fs.existsSync(paths.pdfPath)) {
      if (fs.existsSync(paths.adoDataPath)) {
        const report = JSON.parse(fs.readFileSync(paths.adoDataPath, "utf8"));
        report.pdf = report.pdf || {
          available: false,
          error: "PDF export did not complete for this job. The HTML report and Presentation Mode are still available."
        };
        res.status(409).send(renderAdoReportResultPage({ jobId: req.params.id, report }));
        return;
      }

      res.status(404).send(renderErrorPage("That PDF is no longer available. Please generate the report again."));
      return;
    }

    let downloadName = "sprint-demo.pdf";

    if (fs.existsSync(paths.metaPath)) {
      const metadata = JSON.parse(fs.readFileSync(paths.metaPath, "utf8"));
      downloadName = `${sanitizeDownloadName(metadata.basics && metadata.basics.SprintName)}.pdf`;
    }

    res.download(paths.pdfPath, downloadName);
  } catch (error) {
    res.status(404).send(renderErrorPage(error));
  }
});

app.use((error, req, res, next) => {
  removeJob(req.jobId);

  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    res.status(400).send(renderErrorPage("That upload is too large. Workbooks are limited to 8 MB and review screenshots are limited to 5 MB."));
    return;
  }

  res.status(400).send(renderErrorPage(error));
});

app.listen(port, () => {
  console.log(`SprintGen web app listening on http://localhost:${port}`);
});
