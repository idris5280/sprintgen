const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
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
const runtimeDir = path.join(projectRoot, "runtime");
const jobsDir = path.join(runtimeDir, "jobs");
const sampleWorkbookPath = path.join(projectRoot, "input", "sample-sprint-demo.xlsx");
const maxUploadBytes = 8 * 1024 * 1024;
const maxJobAgeMs = 6 * 60 * 60 * 1000;
const adoConfig = getAdoConfig();
const defaultAdoTeam = process.env.ADO_DEFAULT_TEAM || "(Team7) - Sales Value Stream - Vital Signs";
const adoSessionCookieName = "sprintgen_ado_admin";
const adoSessionTtlMs = 4 * 60 * 60 * 1000;
const adoSessions = new Map();

function ensureRuntimeDirs() {
  fs.mkdirSync(jobsDir, { recursive: true });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeDownloadName(value) {
  const clean = String(value || "sprint-demo")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return clean || "sprint-demo";
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

function getJobDir(jobId) {
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) {
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
  <link rel="stylesheet" href="/assets/styles.css?v=1">
</head>
<body class="${escapeHtml(bodyClass)}">
  <div class="confetti-sprinkle" aria-hidden="true"></div>
  <main class="app-shell">
    ${content}
  </main>
</body>
</html>`;
}

function renderHomePage({ error = "" } = {}) {
  const errorHtml = error
    ? `<div class="alert alert-error"><strong>Workbook check:</strong> ${escapeHtml(error)}</div>`
    : "";

  return renderPage({
    title: "SprintGen - Sprint Demo Builder",
    bodyClass: "home-page",
    content: `
      <section class="hero-grid">
        <div class="upload-panel">
          <div class="eyebrow">SprintGen</div>
          <h1>Build a sprint review from live ADO facts.</h1>
          <p class="lede">Connect with a temporary PAT, choose the team and sprint, review the metrics, write the human context on screen, then generate the report, PDF, and Presentation Mode.</p>
          ${errorHtml}
          <div class="button-row hero-actions">
            <a class="primary-button" href="/ado-admin">Start Sprint Review Builder</a>
            <a class="secondary-button" href="/ado-test">Try ADO data test</a>
          </div>
          <div class="legacy-upload-callout">
            <span>Workbook fallback</span>
            <p>Excel generation still works for teams that want to fill out a spreadsheet manually.</p>
          </div>
          <form class="upload-form" action="/generate" method="post" enctype="multipart/form-data">
            <label class="drop-zone" for="workbook">
              <span class="drop-icon">xlsx</span>
              <span class="drop-title">Drop in your sprint workbook</span>
              <span class="drop-copy">Only .xlsx files, up to 8 MB. No HTML editing required.</span>
              <input id="workbook" name="workbook" type="file" accept=".xlsx" required>
            </label>
            <button class="primary-button" type="submit">Generate report</button>
          </form>
          <div class="button-row">
            <a class="secondary-button" href="/template">Download sample workbook</a>
          </div>
        </div>

        <aside class="spark-card" aria-label="How it works">
          <div class="spark-badge">ADO-powered</div>
          <h2>Facts from ADO, review from the scrum master.</h2>
          <p>SprintGen calculates the numbers and shows the real ADO stories. You choose what belongs in the review, write the delivery updates, and approve the final output.</p>
          <ol class="steps">
            <li><span>1</span><strong>Connect</strong><small>Use a temporary PAT while this is still a work-in-progress tool.</small></li>
            <li><span>2</span><strong>Select</strong><small>Pick the team and sprint directly from Azure DevOps.</small></li>
            <li><span>3</span><strong>Curate</strong><small>Write summary, delivery updates, business value, and next steps on screen.</small></li>
            <li><span>4</span><strong>Generate</strong><small>Create the HTML report, PDF, and Presentation Mode.</small></li>
          </ol>
        </aside>
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
        <p class="lede">Your sprint review is packaged into a polished HTML preview and a PDF download.</p>
        ${warningHtml}
        <div class="result-actions">
          <a class="primary-button" href="/preview/${encodeURIComponent(jobId)}" target="_blank" rel="noreferrer">Open HTML preview</a>
          <a class="secondary-button strong" href="/download/${encodeURIComponent(jobId)}">Download PDF</a>
          <a class="ghost-button" href="/">Generate another report</a>
        </div>
        <div class="present-launch">
          <span>Presentation Mode</span>
          <p>Temporary browser links for same-day screen sharing. The PDF remains the durable artifact.</p>
          <strong>Select a mode:</strong>
          <div class="present-launch-actions">
            <a class="secondary-button" href="/present/${encodeURIComponent(jobId)}?vibe=light" target="_blank" rel="noreferrer">Light</a>
            <a class="secondary-button" href="/present/${encodeURIComponent(jobId)}?vibe=dark" target="_blank" rel="noreferrer">Dark</a>
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

          return `
            <div>
              <span>${escapeHtml(type)} ${escapeHtml(id)}</span>
              <strong>${escapeHtml(title)}</strong>
              <small>${escapeHtml(state)}</small>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
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
              <strong>${escapeHtml(card.value)}</strong>
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
  const finalLabelX = Math.min(width - padding.right - 88, Math.max(padding.left + 8, finalX - 132));
  const finalLabelY = Math.max(padding.top + 16, Math.min(height - padding.bottom - 18, finalY - 18));
  const finalLabel = `Ended: ${formatNumber(finalPoint.remainingStoryPoints)} pts`;
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
        <g class="burn-end-label" transform="translate(${finalLabelX.toFixed(1)} ${finalLabelY.toFixed(1)})">
          <rect width="116" height="30" rx="15" />
          <text x="58" y="20">${escapeHtml(finalLabel)}</text>
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
                }</small>
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

function splitBullets(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
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

  const label = options.label || "User Stories";
  const preview = Boolean(options.preview);
  const visibleStories = preview ? stories.slice(0, options.previewLimit || 4) : [];
  const hiddenCount = Math.max(stories.length - visibleStories.length, 0);
  const pointSummary = totalStoryPoints(stories);
  const itemLabel = stories.length === 1 ? "selected item" : "selected items";

  return `
    <div class="story-summary-pill">
      <strong><span>${escapeHtml(label)}:</span> ${escapeHtml(stories.length)} ${escapeHtml(itemLabel)} / ${escapeHtml(formatNumber(pointSummary))} pts</strong>
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

function parseAdoNarrative(body, currentItems, nextItems) {
  const priorityUpdates = new Set([0, 1, 2].filter((index) => body[`updatePriority${index}`]));
  const updates = [0, 1, 2]
    .map((index) => {
      const title = String(body[`updateTitle${index}`] || "").trim();
      const bullets = splitBullets(body[`updateBullets${index}`]);
      const businessValue = String(body[`updateBusinessValue${index}`] || "").trim();
      const stories = selectStoriesById(currentItems, body[`updateStoryIds${index}`]);
      const priority = priorityUpdates.has(index);

      return {
        title,
        bullets,
        businessValue,
        stories,
        priority
      };
    })
    .filter(
      (update) =>
        update.title || update.bullets.length > 0 || update.businessValue || update.stories.length > 0 || update.priority
    );

  const nextSteps = {
    title: String(body.nextTitle || "").trim(),
    bullets: splitBullets(body.nextBullets),
    stories: selectStoriesById(nextItems, body.nextStoryIds)
  };
  const demo = {
    enabled: Boolean(body.hasDemo),
    title: String(body.demoTitle || "").trim(),
    note: String(body.demoNote || "").trim()
  };

  return {
    summary: String(body.summary || "").trim(),
    openingTitle: String(body.openingTitle || "Opening Remarks").trim(),
    openingSubtitle: String(body.openingSubtitle || "").trim(),
    updates,
    demo,
    nextSteps
  };
}

async function buildAdoReviewDraft({ pat, team, sprint, areaPath = "" }) {
  const result = await buildAdoDataPreview({ pat, team, sprint, areaPath });
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
      nextWorkItems = await queryIterationWorkItems({
        pat,
        org: adoConfig.org,
        project: adoConfig.project,
        team,
        iterationPath: nextIteration.path,
        areaPath: result.areaPath
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

function renderAdoReviewBuilderPage({ draft, error = null } = {}) {
  if (!draft) {
    return renderPage({
      title: "SprintGen - Sprint Review Builder",
      bodyClass: "ado-page",
      content: `
        <section class="result-card error-card">
          <div class="eyebrow">Sprint Review Builder</div>
          <h1>Load a team and sprint first.</h1>
          <p class="lede">${escapeHtml(error && error.message ? error.message : "Choose a sprint from ADO Admin Mode to start the review builder.")}</p>
          <div class="result-actions">
            <a class="primary-button" href="/ado-admin">Back to ADO Admin Mode</a>
          </div>
        </section>
      `
    });
  }

  const result = draft.result;
  const metrics = result.metrics || {};
  const totals = metrics.totals || {};
  const nextLabel = draft.nextIteration ? draft.nextIteration.name : "Next sprint";
  const warningHtml = [draft.nextWorkItems.warning, ...(result.warnings || [])]
    .filter(Boolean)
    .map((warning) => `<li>${escapeHtml(warning)}</li>`)
    .join("");

  return renderPage({
    title: "SprintGen - Build Sprint Review",
    bodyClass: "ado-page builder-page",
    content: `
      <section class="ado-admin-header builder-header">
        <div>
          <div class="eyebrow">Sprint Review Builder</div>
          <h1>Curate the report before SprintGen packages it.</h1>
          <p class="lede">ADO is supplying the metrics and story wording. You add the human context: what mattered, why it mattered, and what comes next.</p>
        </div>
        <a class="secondary-button" href="/ado-admin?team=${encodeURIComponent(result.team)}&areaPath=${encodeURIComponent(result.areaPath || "")}">Back to selections</a>
      </section>

      ${warningHtml ? `<div class="alert alert-warn builder-warning"><strong>Review note:</strong><ul>${warningHtml}</ul></div>` : ""}

      <section class="builder-facts-grid">
        <div class="builder-fact-card">
          <span>Team</span>
          <strong>${escapeHtml(result.team)}</strong>
          <small>${escapeHtml(result.iteration.name)} &middot; ${escapeHtml(formatDateOnly(result.iteration.startDate))} to ${escapeHtml(formatDateOnly(result.iteration.finishDate))}</small>
        </div>
        <div class="builder-fact-card">
          <span>Area path</span>
          <strong>${escapeHtml(result.areaPath || "All team areas")}</strong>
          <small>Used to scope ADO stories, metrics, burndown, and velocity.</small>
        </div>
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
        <div class="builder-fact-card">
          <span>${escapeHtml(nextLabel)}</span>
          <strong>${escapeHtml(draft.nextWorkItems.count)}</strong>
          <small>${draft.nextIteration ? `${escapeHtml(formatDateOnly(draft.nextIteration.startDate))} to ${escapeHtml(formatDateOnly(draft.nextIteration.finishDate))}` : "No next team iteration found"}</small>
        </div>
      </section>

      <form class="story-builder-form" action="/ado-admin/generate-report" method="post">
        <input type="hidden" name="team" value="${escapeHtml(result.team)}">
        <input type="hidden" name="sprint" value="${escapeHtml(result.iteration.path)}">
        <input type="hidden" name="areaPath" value="${escapeHtml(result.areaPath || "")}">

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
              <input class="text-input" id="openingTitle" name="openingTitle" type="text" value="Opening Remarks" placeholder="Example: Opening Remarks">
            </label>
            <label class="field-group" for="openingSubtitle">
              <span>Opening slide subtitle</span>
              <input class="text-input" id="openingSubtitle" name="openingSubtitle" type="text" placeholder="Example: by Product Owner name">
            </label>
          </div>
          <label class="field-group" for="summary">
            <span>Sprint summary</span>
            <textarea class="text-input narrative-textarea" id="summary" name="summary" rows="5">${escapeHtml(defaultSummaryText(result))}</textarea>
          </label>
        </section>

        <section class="narrative-section">
          <div class="section-heading-row">
            <div>
              <span>Delivery updates</span>
              <h2>Group the sprint work into stakeholder-ready updates</h2>
            </div>
            <small>Select the ADO stories that support each update.</small>
          </div>

          <div class="delivery-editor-grid">
            ${[0, 1, 2]
              .map(
                (index) => `
                  <article class="delivery-editor-card">
                    <div class="delivery-card-topline">
                      <span>Update ${index + 1}</span>
                      <label class="priority-check">
                        <input type="checkbox" name="updatePriority${index}" value="yes">
                        <span>#1 priority</span>
                      </label>
                    </div>
                    <label class="field-group" for="updateTitle${index}">
                      <span>Title</span>
                      <input class="text-input" id="updateTitle${index}" name="updateTitle${index}" type="text" placeholder="Example: Enrollment workflow is ready for demo">
                    </label>
                    <label class="field-group" for="updateBullets${index}">
                      <span>Bullet points</span>
                      <textarea class="text-input narrative-textarea" id="updateBullets${index}" name="updateBullets${index}" rows="4" placeholder="One bullet per line"></textarea>
                    </label>
                    <label class="field-group" for="updateBusinessValue${index}">
                      <span>Business value</span>
                      <textarea class="text-input narrative-textarea" id="updateBusinessValue${index}" name="updateBusinessValue${index}" rows="3" placeholder="Why this mattered for users, stakeholders, or operations"></textarea>
                    </label>
                    ${renderStoryPicker({
                      title: "Attach selected sprint ADO stories",
                      name: `updateStoryIds${index}`,
                      items: draft.currentItems,
                      emptyText: "No stories or bugs were found for this sprint."
                    })}
                  </article>
                `
              )
              .join("")}
          </div>
        </section>

        <section class="narrative-section demo-builder-section">
          <div class="section-heading-row">
            <div>
              <span>Live demo handoff</span>
              <h2>Add a presentation pause for a live demo</h2>
            </div>
            <small>If the sprint review includes a live demo, SprintGen will add a dedicated handoff slide before Looking Ahead.</small>
          </div>

          <div class="demo-toggle-panel">
            <label class="demo-check">
              <input type="checkbox" name="hasDemo" value="yes">
              <span>
                <strong>This review includes a live demo</strong>
                <small>Add a clean Live Demo slide to pause the recap.</small>
              </span>
            </label>
            <label class="field-group" for="demoNote">
              <span>Optional internal demo note</span>
              <textarea class="text-input narrative-textarea" id="demoNote" name="demoNote" rows="3" placeholder="Example: Product owner will demo the workflow."></textarea>
            </label>
          </div>
        </section>

        <section class="narrative-section">
          <div class="section-heading-row">
            <div>
              <span>Looking ahead</span>
              <h2>Pick the next sprint work worth previewing</h2>
            </div>
            <small>${draft.nextIteration ? `${escapeHtml(draft.nextIteration.path)}` : "SprintGen could not find the next team iteration automatically."}</small>
          </div>

          <div class="next-editor-grid">
            <div class="next-editor-copy">
              <label class="field-group" for="nextTitle">
                <span>Next steps title</span>
                <input class="text-input" id="nextTitle" name="nextTitle" type="text" value="${escapeHtml(nextLabel)} focus" placeholder="Example: What we are lining up next">
              </label>
              <label class="field-group" for="nextBullets">
                <span>Next steps bullets</span>
                <textarea class="text-input narrative-textarea" id="nextBullets" name="nextBullets" rows="5" placeholder="One bullet per line"></textarea>
              </label>
            </div>
            ${renderStoryPicker({
              title: "Attach next sprint ADO stories",
              name: "nextStoryIds",
              items: draft.nextWorkItems.items,
              emptyText: "No next sprint stories were found or the next iteration is not configured for this team."
            })}
          </div>
        </section>

        <section class="builder-submit-panel">
          <div>
            <span>Ready</span>
            <strong>Generate the report, PDF, and Presentation Mode from this curated review.</strong>
            <small>The PAT remains in memory only. The generated job stores ADO facts and your approved narrative, not the PAT.</small>
          </div>
          <button class="primary-button" type="submit">Generate ADO report</button>
        </section>
      </form>

      <script>
        document.querySelectorAll("[data-story-picker]").forEach(function (picker) {
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
      </script>
    `
  });
}

function renderAdoDeliveryUpdates(updates) {
  if (!updates || updates.length === 0) {
    return `<div class="empty-state">No delivery updates were added. Return to the builder to add stakeholder-facing context.</div>`;
  }

  return `
    <div class="ado-report-update-grid">
      ${updates
        .map(
          (update) => `
            <article class="ado-report-update-card${update.priority ? " priority" : ""}">
              <div class="update-card-heading">
                <h3>${escapeHtml(update.title || "Update")}</h3>
                ${update.priority ? `<span>#1 priority</span>` : ""}
              </div>
              ${renderBulletList(update.bullets, "No bullet points were added for this update.")}
              ${
                update.businessValue
                  ? `<div class="business-value-box"><span>Stakeholder value</span><p>${escapeHtml(update.businessValue)}</p></div>`
                  : ""
              }
              ${
                update.stories && update.stories.length > 0
                  ? `<div class="story-evidence">
                      ${renderStoryChips(update.stories)}
                    </div>`
                  : ""
              }
            </article>
          `
        )
        .join("")}
    </div>
  `;
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

  return `
    <section class="ado-report-section">
      <div>
        <span>Live demo</span>
        <h2>Live Demo</h2>
      </div>
      <div class="demo-report-card">
        <p>${escapeHtml(demo.note || "This sprint review includes a live demo.")}</p>
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
    .ado-report-contributors span,
    .next-copy-panel > span {
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
    .ado-report-contributors p {
      font-size: .98rem;
      line-height: 1.45;
      margin: 0;
      max-width: none;
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
    .story-evidence {
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
    .burn-end-label rect {
      fill: #10212c;
      filter: drop-shadow(0 8px 16px rgba(16, 33, 44, .2));
      stroke: rgba(255, 255, 255, .72);
      stroke-width: 1;
    }
    .burn-end-label text {
      fill: #ffffff;
      font-size: 12px;
      font-weight: 850;
      text-anchor: middle;
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
    .ado-report-update-card {
      border-left: 6px solid #0ebfca;
      padding: 22px;
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
      .ado-report-next-grid {
        grid-template-columns: 1fr;
      }
      .velocity-points { text-align: center; }
    }
  `;
}

function renderAdoReportContributors(contributors) {
  if (!contributors || contributors.length === 0) {
    return "";
  }

  const visible = contributors.slice(0, 18);
  const hiddenCount = Math.max(contributors.length - visible.length, 0);

  return `
    <div class="ado-report-contributors">
      <span>Sprint contributors</span>
      <p>${escapeHtml(visible.join(", "))}${hiddenCount > 0 ? ` and ${escapeHtml(hiddenCount)} more` : ""}</p>
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
    <header class="ado-report-hero">
      <span>SprintGen ADO report</span>
      <h1>${escapeHtml(result.iteration.name)}</h1>
      <p>${escapeHtml(summary)}</p>
      <div class="hero-facts">
        <div><span>Team</span><strong>${escapeHtml(result.team)}</strong></div>
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
        <span>Sprint highlights</span>
        <h2>What was delivered</h2>
      </div>
      ${renderAdoDeliveryUpdates(narrative.updates || [])}
    </section>

    ${renderAdoDemoSection(narrative.demo)}

    <section class="ado-report-section">
      <div>
        <span>Looking ahead</span>
        <h2>What is lining up next</h2>
      </div>
      ${renderAdoNextSteps(narrative.nextSteps || { title: "", bullets: [], stories: [] }, nextIteration)}
    </section>

    <footer class="ado-report-footer">
      Generated by SprintGen on ${escapeHtml(generatedAt)}. ADO supplied facts and story wording. Scrum master narrative was reviewed on screen before generation.
    </footer>
  </main>
</body>
</html>`;
}

function renderAdoReportResultPage({ jobId, report }) {
  const result = report.result || report;
  const warnings = result.warnings || [];
  const pdf = report.pdf || { available: true };
  const pdfWarningHtml =
    pdf.available === false
      ? `<div class="alert alert-warn"><strong>PDF needs a retry:</strong> ${escapeHtml(
          pdf.error || "PDF export did not complete, but the HTML report and Presentation Mode are ready."
        )}</div>`
      : "";
  const warningHtml =
    warnings.length > 0
      ? `<div class="alert alert-warn"><strong>Review note:</strong><ul>${warnings
          .map((warning) => `<li>${escapeHtml(warning)}</li>`)
          .join("")}</ul></div>`
      : `<div class="alert alert-good"><strong>ADO report is ready.</strong> Metrics, selected stories, HTML, and Presentation Mode were generated from your curated sprint review.</div>`;
  const pdfAction =
    pdf.available === false
      ? `<span class="secondary-button disabled-button" aria-disabled="true">PDF unavailable locally</span>`
      : `<a class="secondary-button strong" href="/download/${encodeURIComponent(jobId)}">Download PDF</a>`;

  return renderPage({
    title: "SprintGen - ADO Report Ready",
    bodyClass: "result-page ado-page",
    content: `
      <section class="result-card ado-report-ready-card">
        <div class="success-orb">win</div>
        <div class="eyebrow">ADO report ready</div>
        <h1>${escapeHtml(result.iteration.name)} is packaged for stakeholders.</h1>
        <p class="lede">SprintGen combined ADO metrics, ADO story wording, and your approved sprint review narrative into a report and screen-share presentation.</p>
        ${warningHtml}
        ${pdfWarningHtml}
        <div class="result-actions">
          <a class="primary-button" href="/preview/${encodeURIComponent(jobId)}" target="_blank" rel="noreferrer">Open HTML report</a>
          ${pdfAction}
          <a class="ghost-button" href="/ado-admin">Build another ADO report</a>
        </div>
        <div class="present-launch">
          <span>Presentation Mode</span>
          <p>Choose the screen-share vibe for this generated ADO review.</p>
          <strong>Select a mode:</strong>
          <div class="present-launch-actions">
            <a class="secondary-button" href="/ado-present/${encodeURIComponent(jobId)}?vibe=light" target="_blank" rel="noreferrer">Light</a>
            <a class="secondary-button" href="/ado-present/${encodeURIComponent(jobId)}?vibe=dark" target="_blank" rel="noreferrer">Dark</a>
            <a class="secondary-button strong" href="/ado-present/${encodeURIComponent(jobId)}?vibe=prismatic" target="_blank" rel="noreferrer">Prismatic</a>
          </div>
        </div>
        <div class="mini-summary">
          <div><span>Team</span><strong>${escapeHtml(result.team)}</strong></div>
          <div><span>Sprint</span><strong>${escapeHtml(result.iteration.name)}</strong></div>
          <div><span>Delivery updates</span><strong>${escapeHtml((report.narrative.updates || []).length)}</strong></div>
        </div>
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
            <span>Configured source</span>
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
                  <h2>Stories SprintGen can read next</h2>
                </div>
                ${renderAdoWorkItems(result.workItems.items)}
              </section>`
            : ""
        }
      </section>
    `
    : "";

  return renderPage({
    title: "SprintGen - ADO Feasibility Test",
    bodyClass: "ado-page",
    content: `
      <section class="ado-hero">
        <div class="ado-copy">
          <div class="eyebrow">Phase 1 data lab</div>
          <h1>Check whether SprintGen can read your sprint facts.</h1>
          <p class="lede">Use a short-lived Azure DevOps PAT to test team iterations, Analytics metadata, WorkItemSnapshot burndown rows, and current sprint work items.</p>
          <div class="ado-northstar">
            <strong>North Star</strong>
            <p>ADO provides facts. SprintGen calculates metrics. The scrum master edits and approves the final story.</p>
          </div>
        </div>

        <form class="ado-form-card" action="/ado-test" method="post" autocomplete="off">
          <div class="form-heading">
            <span>Configured project</span>
            <strong>${escapeHtml(adoConfig.org)} / ${escapeHtml(adoConfig.project)}</strong>
          </div>
          ${errorHtml}
          <label class="field-group" for="pat">
            <span>Azure DevOps PAT</span>
            <input class="text-input" id="pat" name="pat" type="password" required placeholder="Paste PAT for this test only" autocomplete="off">
            <small>The token is used only for this request. SprintGen does not save it.</small>
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
          <a class="ghost-button full-width" href="/">Back to workbook generator</a>
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
          <h2>Completed work SprintGen can summarize next</h2>
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
          <input type="hidden" name="areaPath" value="${escapeHtml(result.areaPath || "")}">
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
          <span>Area path</span>
          <strong>${escapeHtml(result.areaPath || "All team areas")}</strong>
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
                <h2>Stories SprintGen can read next</h2>
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

function renderAreaOptions(areaPaths, selectedAreaPath) {
  const selected = String(selectedAreaPath || "");
  const options = (areaPaths || [])
    .map((area) => {
      const value = area.value || "";

      return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`;
    })
    .join("");

  return `<option value="">Select an area path</option>${options}`;
}

function resolveSelectedAreaPath(areaPaths, selectedAreaPath, defaultAreaPath = "") {
  const selected = String(selectedAreaPath || "").trim();
  const areas = areaPaths || [];

  if (selected && areas.some((area) => area.value === selected)) {
    return selected;
  }

  if (selected && areas.length === 0) {
    return selected;
  }

  if (defaultAreaPath && areas.some((area) => area.value === defaultAreaPath)) {
    return defaultAreaPath;
  }

  return (areas[0] && areas[0].value) || selected || "";
}

function getSprintLabel(iterationPath) {
  const parts = String(iterationPath || "").split("\\").filter(Boolean);
  return parts[parts.length - 1] || "Sprint";
}

function renderAdoAdminConnectPage({ error = null } = {}) {
  const errorHtml = error
    ? `<div class="alert alert-error"><strong>Could not connect:</strong> ${escapeHtml(error.message)}${
        error.detail ? `<small>${escapeHtml(error.detail)}</small>` : ""
      }</div>`
    : "";

  return renderPage({
    title: "SprintGen - ADO Admin Mode",
    bodyClass: "ado-page",
    content: `
      <section class="ado-hero">
        <div class="ado-copy">
          <div class="eyebrow">ADO Admin Mode</div>
          <h1>Generate sprint intelligence for any readable team.</h1>
          <p class="lede">Connect once with a read-capable Azure DevOps PAT, then choose a team and sprint from dropdowns. This keeps Phase 2 fast while we are still in work-in-progress mode.</p>
          <div class="ado-northstar">
            <strong>Temporary admin flow</strong>
            <p>The PAT stays in server memory for this browser session only. It is not saved to disk, logged, or placed in URLs.</p>
          </div>
        </div>

        <form class="ado-form-card" action="/ado-admin/connect" method="post" autocomplete="off">
          <div class="form-heading">
            <span>Configured project</span>
            <strong>${escapeHtml(adoConfig.org)} / ${escapeHtml(adoConfig.project)}</strong>
          </div>
          ${errorHtml}
          <label class="field-group" for="pat">
            <span>Azure DevOps PAT</span>
            <input class="text-input" id="pat" name="pat" type="password" required placeholder="Paste admin/read PAT" autocomplete="off">
            <small>Use a short-lived PAT with read access to teams, iterations, work items, and Analytics.</small>
          </label>
          <button class="primary-button" type="submit">Connect to ADO</button>
          <a class="ghost-button full-width" href="/">Back to workbook generator</a>
        </form>
      </section>
    `
  });
}

function renderAdoAdminPage({
  teams = [],
  selectedTeam = "",
  areaPaths = [],
  selectedAreaPath = "",
  iterations = [],
  result = null,
  error = null
} = {}) {
  const errorHtml = error
    ? `<div class="alert alert-error"><strong>ADO admin note:</strong> ${escapeHtml(error.message)}${
        error.detail ? `<small>${escapeHtml(error.detail)}</small>` : ""
      }</div>`
    : "";

  const selectedTeamHtml = selectedTeam
    ? `<div class="alert alert-good"><strong>${escapeHtml(selectedTeam)}</strong> is selected. ${escapeHtml(areaPaths.length)} area paths and ${escapeHtml(iterations.length)} team iterations are available.</div>`
    : `<div class="alert alert-warn"><strong>Choose a team first.</strong> SprintGen will load that team's area paths and sprint list after you select one.</div>`;

  const sprintFormHtml = selectedTeam
    ? `
      <form class="selector-form" action="/ado-admin/review" method="post">
        <input type="hidden" name="team" value="${escapeHtml(selectedTeam)}">
        <label class="field-group" for="areaPath">
          <span>Area path</span>
          ${
            areaPaths.length > 0
              ? `<select class="text-input" id="areaPath" name="areaPath" required>
                  ${renderAreaOptions(areaPaths, selectedAreaPath)}
                </select>`
              : `<input class="text-input" id="areaPath" name="areaPath" type="text" value="${escapeHtml(selectedAreaPath)}" placeholder="Digital Transformation\\Sales Value Stream\\...">`
          }
          <small>This scopes the data so sibling teams or value streams do not leak into the review.</small>
        </label>
        <label class="field-group" for="sprint">
          <span>Sprint</span>
          <select class="text-input" id="sprint" name="sprint" required>
            ${renderIterationOptions(iterations)}
          </select>
          <small>Select the sprint SprintGen should import next.</small>
        </label>
        <button class="primary-button" type="submit">Build Sprint Review</button>
      </form>
    `
    : "";

  return renderPage({
    title: "SprintGen - ADO Admin Mode",
    bodyClass: "ado-page",
    content: `
      <section class="ado-admin-header">
        <div>
          <div class="eyebrow">ADO Admin Mode</div>
          <h1>Pick a team, pick a sprint, build the next report.</h1>
          <p class="lede">You are connected to ${escapeHtml(adoConfig.org)} / ${escapeHtml(adoConfig.project)} with an in-memory PAT session.</p>
        </div>
        <form action="/ado-admin/disconnect" method="post">
          <button class="secondary-button" type="submit">Disconnect PAT</button>
        </form>
      </section>

      <section class="ado-selector-grid">
        <div class="ado-form-card">
          <div class="form-heading">
            <span>Readable teams</span>
            <strong>${escapeHtml(teams.length)} teams available</strong>
          </div>
          ${errorHtml}
          <form class="selector-form" action="/ado-admin" method="get">
            <label class="field-group" for="team">
              <span>Team</span>
              <select class="text-input" id="team" name="team" required>
                ${renderTeamOptions(teams, selectedTeam)}
              </select>
              <small>Teams come directly from Azure DevOps project access.</small>
            </label>
            <button class="primary-button" type="submit">Load team scope</button>
          </form>
        </div>

        <div class="ado-form-card">
          <div class="form-heading">
            <span>Review scope</span>
            <strong>${selectedTeam ? "Area + sprint" : "Waiting for team"}</strong>
          </div>
          ${selectedTeamHtml}
          ${sprintFormHtml}
        </div>
      </section>

      ${renderAdoStatusSummary(result)}
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

function renderAdoPresentationUpdateSlides(updates) {
  if (!updates || updates.length === 0) {
    return "";
  }

  return updates
    .map(
      (update, index) => `
        <section class="ado-present-slide">
          <div class="present-card wide narrative-card">
            <span class="present-kicker">${update.priority ? "#1 priority" : `Delivery Update ${index + 1}`}</span>
            <h2>${escapeHtml(update.title || `Delivery update ${index + 1}`)}</h2>
            <div class="present-narrative-grid${update.stories && update.stories.length > 0 ? "" : " single"}">
              <div class="present-copy-block">
                ${renderBulletList(update.bullets, "No bullet points were added for this update.")}
                ${
                  update.businessValue
                    ? `<div class="present-business-value"><span>Business Value</span><p>${escapeHtml(update.businessValue)}</p></div>`
                    : ""
                }
              </div>
              ${
                update.stories && update.stories.length > 0
                  ? `<div class="present-story-block">
                      ${renderStoryChips(update.stories)}
                    </div>`
                  : ""
              }
            </div>
          </div>
        </section>
      `
    )
    .join("");
}

function renderAdoPresentationDemoSlide(demo) {
  if (!demo || !demo.enabled) {
    return "";
  }

  return `
    <section class="ado-present-slide demo-handoff-slide">
      <div class="present-card demo-handoff-card">
        <h2>Live Demo</h2>
      </div>
    </section>
  `;
}

function renderPresentationContributors(contributors) {
  if (!contributors || contributors.length === 0) {
    return "";
  }

  const visible = contributors.slice(0, 12);
  const hiddenCount = Math.max(contributors.length - visible.length, 0);

  return `
    <div class="present-contributors">
      <span>Sprint contributors</span>
      <p>${escapeHtml(visible.join(", "))}${hiddenCount > 0 ? ` and ${escapeHtml(hiddenCount)} more` : ""}</p>
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
      ${renderAdoPresentationUpdateSlides(narrative.updates || [])}
      ${renderAdoPresentationDemoSlide(narrative.demo)}
      <section class="ado-present-slide">
        <div class="present-card wide narrative-card">
          <span class="present-kicker">Looking Ahead</span>
          <h2>${escapeHtml((narrative.nextSteps && narrative.nextSteps.title) || (nextIteration && nextIteration.name) || "What is next")}</h2>
          <div class="present-narrative-grid${narrative.nextSteps && narrative.nextSteps.stories && narrative.nextSteps.stories.length > 0 ? "" : " single"}">
            <div class="present-copy-block">
              ${renderBulletList(narrative.nextSteps && narrative.nextSteps.bullets ? narrative.nextSteps.bullets : [], "No next-step bullets were added.")}
            </div>
            ${
              narrative.nextSteps && narrative.nextSteps.stories && narrative.nextSteps.stories.length > 0
                ? `<div class="present-story-block">
                    <span>${escapeHtml(nextIteration ? nextIteration.name : "Next sprint")} stories</span>
                    ${renderStoryChips(narrative.nextSteps.stories, "", { preview: true, previewLimit: 4 })}
                  </div>`
                : ""
            }
          </div>
        </div>
      </section>
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
      </section>
    `
    : `
      <section class="ado-present-slide closing">
        <div class="present-card">
          <span class="present-kicker">Next Build Step</span>
          <h2>Turn these facts into an editable sprint review.</h2>
          <p>The next layer should combine these ADO facts with web-form narrative fields for business value, demo focus, and looking ahead.</p>
        </div>
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
  <link rel="stylesheet" href="/assets/ado-present.css?v=7">
</head>
<body class="vibe-${escapeHtml(vibe)}">
  <div class="present-progress" aria-hidden="true"><span></span></div>
  <main class="ado-present-deck" data-deck>
    <section class="ado-present-slide opening">
      <div class="present-card">
        <span class="present-kicker">Sprint Recap</span>
        <h1>${escapeHtml(result.iteration.name)}</h1>
        <p>${escapeHtml(result.team)}</p>
        <dl>
          <div><dt>Dates</dt><dd>${escapeHtml(formatDateOnly(result.iteration.startDate))} to ${escapeHtml(formatDateOnly(result.iteration.finishDate))}</dd></div>
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
    <button type="button" data-prev>Previous</button>
    <button type="button" data-next>Next</button>
  </nav>
  <script src="/assets/ado-present.js?v=7"></script>
</body>
</html>`;
}

function renderErrorPage(error) {
  return renderPage({
    title: "SprintGen - Needs Attention",
    bodyClass: "error-page",
    content: `
      <section class="result-card error-card">
        <div class="success-orb calm">fix</div>
        <div class="eyebrow">SprintGen needs a tweak</div>
        <h1>We could not generate that report yet.</h1>
        <p class="lede">${escapeHtml(error.message || error)}</p>
        <div class="result-actions">
          <a class="primary-button" href="/">Try another workbook</a>
          <a class="secondary-button" href="/template">Download sample workbook</a>
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

async function buildAdoDataPreview({ pat, team, sprint, areaPath = "" }) {
  const selectedAreaPath = String(areaPath || "").trim();
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
  const burndownRows = await queryIterationSnapshotRows({
    pat,
    org: adoConfig.org,
    project: adoConfig.project,
    team,
    iterationPath: iteration.path,
    areaPath: selectedAreaPath
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
    workItems = await queryIterationWorkItems({
      pat,
      org: adoConfig.org,
      project: adoConfig.project,
      team,
      iterationPath: iteration.path,
      areaPath: selectedAreaPath
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
      const velocityWorkItems = await queryIterationWorkItems({
        pat,
          org: adoConfig.org,
          project: adoConfig.project,
          team,
          iterationPath: velocityIteration.path,
          areaPath: selectedAreaPath
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

  return {
    config: adoConfig,
    team,
    areaPath: selectedAreaPath,
    iteration,
    iterations: iterationsResult.iterations,
    iterationCount: iterationsResult.count,
    metadata,
    burndown,
    workItems,
    metrics,
    warnings
  };
}

app.use("/assets", express.static(path.join(projectRoot, "public"), { maxAge: 0 }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

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

app.get("/ado-admin", async (req, res) => {
  const session = getAdoSession(req);

  if (!session) {
    res.send(renderAdoAdminConnectPage());
    return;
  }

  try {
    const selectedTeam = String(req.query.team || "").trim();
    const requestedAreaPath = String(req.query.areaPath || "").trim();
    const teamsResult = await listProjectTeams({
      pat: session.pat,
      org: adoConfig.org,
      project: adoConfig.project
    });
    let iterations = [];
    let areaPaths = [];
    let selectedAreaPath = requestedAreaPath;

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
      selectedAreaPath = resolveSelectedAreaPath(areaPaths, requestedAreaPath, areaPathsResult.defaultValue);
    }

    res.send(
      renderAdoAdminPage({
        teams: teamsResult.teams,
        selectedTeam,
        areaPaths,
        selectedAreaPath,
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

async function handleAdoReviewBuilder(req, res) {
  const session = getAdoSession(req);

  if (!session) {
    res.status(401).send(
      renderAdoAdminConnectPage({
        error: {
          message: "Your temporary ADO admin session expired. Paste the PAT again to build the sprint review."
        }
      })
    );
    return;
  }

  const selectedTeam = String(req.body.team || "").trim();
  const selectedSprint = String(req.body.sprint || "").trim();
  const selectedAreaPath = String(req.body.areaPath || "").trim();

  try {
    const draft = await buildAdoReviewDraft({
      pat: session.pat,
      team: selectedTeam,
      sprint: selectedSprint,
      areaPath: selectedAreaPath
    });

    res.send(renderAdoReviewBuilderPage({ draft }));
  } catch (error) {
    const formattedError = formatAdoError(error);

    res.status(formattedError.status).send(
      renderAdoReviewBuilderPage({
        error: formattedError
      })
    );
  }
}

app.post("/ado-admin/preview", handleAdoReviewBuilder);
app.post("/ado-admin/review", handleAdoReviewBuilder);
app.post("/ado-admin/story", handleAdoReviewBuilder);

app.post("/ado-admin/generate-report", createJobId, async (req, res) => {
  const session = getAdoSession(req);

  if (!session) {
    removeJob(req.jobId);
    res.status(401).send(
      renderAdoAdminConnectPage({
        error: {
          message: "Your temporary ADO admin session expired. Paste the PAT again to generate the ADO report."
        }
      })
    );
    return;
  }

  const selectedTeam = String(req.body.team || "").trim();
  const selectedSprint = String(req.body.sprint || "").trim();
  const selectedAreaPath = String(req.body.areaPath || "").trim();

  try {
    const draft = await buildAdoReviewDraft({
      pat: session.pat,
      team: selectedTeam,
      sprint: selectedSprint,
      areaPath: selectedAreaPath
    });
    const narrative = parseAdoNarrative(req.body, draft.currentItems, draft.nextWorkItems.items);

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
      res.status(404).send(renderErrorPage("That ADO report is no longer available. Please generate it again from ADO Admin Mode."));
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
          message: "Your temporary ADO admin session expired. Paste the PAT again to create a presentation."
        }
      })
    );
    return;
  }

  const selectedTeam = String(req.body.team || "").trim();
  const selectedSprint = String(req.body.sprint || "").trim();
  const selectedAreaPath = String(req.body.areaPath || "").trim();

  try {
    const result = await buildAdoDataPreview({
      pat: session.pat,
      team: selectedTeam,
      sprint: selectedSprint,
      areaPath: selectedAreaPath
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
      res.status(404).send(renderErrorPage("That ADO presentation is no longer available. Please create it again from ADO Admin Mode."));
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
    res.status(400).send(renderErrorPage("That workbook is larger than 8 MB. Please upload a smaller .xlsx file."));
    return;
  }

  res.status(400).send(renderErrorPage(error));
});

app.listen(port, () => {
  console.log(`SprintGen web app listening on http://localhost:${port}`);
});
