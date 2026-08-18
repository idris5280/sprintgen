const { validateProductionConfig } = require("./runtimeSafety");

validateProductionConfig();
require("./telemetry").startTelemetry();

const crypto = require("crypto");
const express = require("express");
const { renderBrandRail } = require("./brandRail");
const {
  buildPresentationColorTokens,
  canonicalPresentationColor,
  exportPdf,
  isValidPresentationColor,
  normalizePresentationColor,
  normalizePresentationVibe,
  projectRoot
} = require("./reportGenerator");
const {
  fetchAnalyticsMetadata,
  getAdoConfig,
  listProjectTeams,
  listTeamAreaPaths,
  listTeamIterations,
  queryIterationSnapshotRows,
  queryIterationWorkItems,
  resolveIterationInput,
  setAdoAuthProvider,
  summarizeBurndownRows
} = require("./adoClient");
const { buildAdoMetrics, findNextIteration, findVelocityIterations, normalizeWorkItem } = require("./adoMetrics");
const { getAdoAuth } = require("./azureIdentity");
const { createArtifactEngine } = require("./artifactEngine");
const { logEvent } = require("./logger");
const { createReviewStore } = require("./reviewStore");
const { attachRequestContext, requireApiUser, requireSameOrigin } = require("./userContext");

const app = express();
const port = process.env.PORT || 3000;
setAdoAuthProvider(getAdoAuth);
const adoConfig = getAdoConfig();
const reviewStore = createReviewStore({ projectRoot });

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

function getHtmlDownloadName(value) {
  return `${sanitizeDownloadName(value || "sprint-review")}.html`;
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
    "credential",
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

function normalizePresentationSettings(value = {}) {
  return {
    color: normalizePresentationColor(value && value.color)
  };
}

function createSavedReviewFromReport(report, existingReview = null) {
  const result = report.result || {};
  const iteration = result.iteration || {};
  const now = new Date().toISOString();
  const id = (existingReview && existingReview.id) || crypto.randomUUID();

  return stripSensitiveReviewKeys({
    id,
    source: result.source === "manual" ? "manual" : "ado",
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
    presentation: normalizePresentationSettings(
      report.presentation || (existingReview && existingReview.presentation) || {}
    ),
    pdf: report.pdf || {
      available: false,
      error: ""
    },
    generation: {
      source: result.source === "manual" ? "Manual review" : "Azure DevOps snapshot",
      app: "Scrum Studio"
    }
  });
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

function isContributorFieldWarning(warning) {
  return /AssignedTo|Assigned To|Contributor names|contributor names|could not fill contributor/i.test(String(warning || ""));
}

function filterContributorWarnings(warnings, contributors) {
  const hasContributors = Array.isArray(contributors) && contributors.length > 0;

  return (warnings || []).filter((warning) => warning && (!hasContributors || !isContributorFieldWarning(warning)));
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

async function queryIterationSnapshotRowsForAreas({ org, project, team, iterationPath, areaPaths = [] }) {
  const selectedAreaPaths = normalizeAreaPathList(areaPaths);

  if (selectedAreaPaths.length === 0) {
    return queryIterationSnapshotRows({ org, project, team, iterationPath, areaPath: "" });
  }

  const rows = [];

  for (const areaPath of selectedAreaPaths) {
    const areaRows = await queryIterationSnapshotRows({ org, project, team, iterationPath, areaPath });
    rows.push(...areaRows.map((row) => ({ ...row, AreaPath: row.AreaPath || areaPath })));
  }

  return rows;
}

async function queryIterationWorkItemsForAreas({ org, project, team, iterationPath, areaPaths = [] }) {
  const selectedAreaPaths = normalizeAreaPathList(areaPaths);

  if (selectedAreaPaths.length === 0) {
    return queryIterationWorkItems({ org, project, team, iterationPath, areaPath: "" });
  }

  const results = [];

  for (const areaPath of selectedAreaPaths) {
    const result = await queryIterationWorkItems({ org, project, team, iterationPath, areaPath });
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
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean);
}

function bodyTextFromSection(section) {
  const rawBody = section && section.bodyText;

  if (typeof rawBody === "string" && rawBody.trim()) {
    return rawBody.trim();
  }

  return Array.isArray(section && section.bullets) ? section.bullets.join("\n").trim() : "";
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

function renderStoryChips(stories, emptyText = "", options = {}) {
  if (!stories || stories.length === 0) {
    return emptyText ? `<div class="empty-state">${escapeHtml(emptyText)}</div>` : "";
  }

  const preview = Boolean(options.preview);
  const visibleStories = preview ? stories.slice(0, options.previewLimit || 4) : stories;
  const hiddenCount = Math.max(stories.length - visibleStories.length, 0);

  return `
    <div class="linked-story-list${preview ? " preview" : ""}">
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
    ${hiddenCount > 0 ? `<div class="linked-story-more">+ ${escapeHtml(hiddenCount)} more queued</div>` : ""}
  `;
}

function renderBulletList(bullets, emptyText = "") {
  if (!bullets || bullets.length === 0) {
    return emptyText ? `<p>${escapeHtml(emptyText)}</p>` : "";
  }

  return `<ul>${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`;
}

function renderBodyText(value, emptyText = "") {
  const raw = String(value || "").trim();

  if (!raw) {
    return emptyText ? `<p>${escapeHtml(emptyText)}</p>` : "";
  }

  const blocks = raw
    .split(/\r?\n\s*\r?\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length > 1) {
    return blocks
      .map((block) => `<p>${escapeHtml(block.replace(/\s*\r?\n\s*/g, " "))}</p>`)
      .join("");
  }

  const lines = blocks[0]
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean);

  if (lines.length > 1) {
    return renderBulletList(lines, emptyText);
  }

  return `<p>${escapeHtml(lines[0] || blocks[0])}</p>`;
}

function renderSectionBodyText(section, emptyText = "") {
  return renderBodyText(bodyTextFromSection(section), emptyText);
}

function defaultSummaryText(result) {
  const totals = (result.metrics && result.metrics.totals) || {};
  const iteration = result.iteration || {};
  const sprintName = iteration.name || getSprintLabel(iteration.path) || "This sprint";
  const team = result.team || "the team";
  const parts = [
    `${sprintName} for ${team} is being shaped into a clear stakeholder readout.`
  ];

  if (result.metrics && result.metrics.totals) {
    parts.push(
      `The sprint delivered ${formatNumber(totals.deliveredStoryPoints || 0)} story points across ${formatNumber(totals.completedItems || 0)} completed items.`
    );
  }

  return parts.join(" ");
}

const reviewMetricSectionTypes = ["agile_metrics", "burndown", "velocity"];

function isMetricSectionType(type) {
  return reviewMetricSectionTypes.includes(String(type || "").trim().toLowerCase());
}

function hasAdoMetrics(result) {
  return Boolean(result && result.metrics && result.metrics.totals);
}

function normalizeSectionType(value) {
  const type = String(value || "").trim().toLowerCase();
  return ["delivery", "screenshot", "challenge", "risk", "next_steps", "live_demo", ...reviewMetricSectionTypes].includes(type) ? type : "delivery";
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

  return icons[normalizeSectionType(type)] || "";
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

function isReviewImageDataUrl(value) {
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(String(value || ""));
}

function normalizeTeamLogo(value) {
  const source = value || {};

  return {
    imageData: isReviewImageDataUrl(source.imageData) ? source.imageData : "",
    imageName: String(source.imageName || "").trim(),
    mediaRef: String(source.mediaRef || "").trim()
  };
}

function createDefaultReviewSection(type, index = 0, id = "") {
  const normalizedType = normalizeSectionType(type);
  const sectionId = normalizeSectionId(id, index, normalizedType);
  const base = {
    id: sectionId,
    type: normalizedType,
    title: "",
    bodyText: "",
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
      imageName: "",
      mediaRef: ""
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

  if (isMetricSectionType(normalizedType)) {
    return base;
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

  if (isMetricSectionType(type)) {
    normalized.title = "";
    return normalized;
  }

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

  normalized.bodyText = String(source.bodyText || "").trim();
  if (!normalized.bodyText && Array.isArray(source.bullets)) {
    normalized.bodyText = source.bullets.map((bullet) => String(bullet || "").trim()).filter(Boolean).join("\n");
  }
  normalized.bullets = splitBullets(normalized.bodyText);
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
    normalized.mediaRef = String(source.mediaRef || "").trim();
  }

  return normalized;
}

function reviewSectionHasContent(section) {
  if (!section) return false;

  if (isMetricSectionType(section.type)) {
    return true;
  }

  if (section.type === "risk") {
    return Boolean(section.title || section.description || section.owner || section.notes);
  }

  if (section.type === "screenshot") {
    return Boolean(section.title || section.bodyText || section.bullets.length > 0 || section.businessValue || section.imageData || section.mediaRef);
  }

  if (section.type === "delivery") {
    return Boolean(section.title || section.bodyText || section.bullets.length > 0 || section.businessValue || section.stories.length > 0 || section.priority);
  }

  if (section.type === "next_steps") {
    return Boolean(section.title || section.bodyText || section.bullets.length > 0 || section.businessValue || section.stories.length > 0);
  }

  if (section.type === "live_demo") {
    return Boolean(
      section.enabled ||
        (section.title && section.title.toLowerCase() !== "live demo") ||
        (Array.isArray(section.presenters) && section.presenters.length > 0) ||
        section.note
    );
  }

  return Boolean(section.title || section.bodyText || section.bullets.length > 0 || section.businessValue);
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
      bodyText: currentNarrative.nextSteps && currentNarrative.nextSteps.bodyText,
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

function createDefaultMetricSections(startIndex = 0) {
  return reviewMetricSectionTypes.map((type, offset) =>
    createDefaultReviewSection(type, startIndex + offset, `${type}-1`)
  );
}

function sectionsForGeneratedOutput(narrative, result) {
  const sections = normalizeNarrativeSections(narrative);
  const shouldIncludeDefaultMetrics = hasAdoMetrics(result) &&
    !(narrative && narrative.metricSectionsConfigured) &&
    !sections.some((section) => isMetricSectionType(section.type));

  return shouldIncludeDefaultMetrics ? [...createDefaultMetricSections(), ...sections] : sections;
}

function deliveryUpdatesFromSections(sections) {
  return (sections || []).filter((section) => section.type === "delivery");
}

function nextStepsFromSections(sections) {
  const section = (sections || []).find((candidate) => candidate.type === "next_steps");

  if (!section) {
    return {
      title: "",
      bodyText: "",
      bullets: [],
      stories: []
    };
  }

  return {
    title: section.title || "",
    bodyText: bodyTextFromSection(section),
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

function buildManualReviewDraft({ team = "", sprint = "", startDate = "", finishDate = "" } = {}) {
  const sprintName = String(sprint || "Sprint Spotlight").trim() || "Sprint Spotlight";
  const iteration = {
    name: sprintName,
    path: sprintName,
    startDate: String(startDate || "").trim(),
    finishDate: String(finishDate || "").trim()
  };

  return {
    result: {
      source: "manual",
      config: adoConfig,
      team: String(team || "").trim(),
      areaPath: "",
      areaPaths: [],
      areaPathLabel: "",
      iteration,
      iterations: [],
      iterationCount: 0,
      workItems: {
        source: "Manual review",
        count: 0,
        items: []
      },
      metrics: {},
      warnings: []
    },
    currentItems: [],
    completedItems: [],
    nextIteration: null,
    nextWorkItems: {
      source: "Manual review",
      count: 0,
      items: [],
      warning: ""
    }
  };
}

async function buildAdoReviewDraft({ team, sprint, areaPath = "", areaPaths = [] }) {
  const selectedAreaPaths = normalizeAreaPathList(areaPaths, areaPath);
  const result = await buildAdoDataPreview({ team, sprint, areaPaths: selectedAreaPaths });
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

function renderAdoReportBusinessValue(value) {
  return value ? `<div class="business-value-box"><span>Business value</span>${renderBodyText(value)}</div>` : "";
}

function renderAdoReportDeliverySection(section, index) {
  return `
    <article class="ado-report-update-card${section.priority ? " priority" : ""}">
      <div class="update-card-heading">
        ${section.title ? `<h3>${escapeHtml(section.title)}</h3>` : ""}
        ${section.priority ? `<span>#1 priority</span>` : ""}
      </div>
      ${renderSectionBodyText(section, "No body text was added for this update.")}
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
          ${section.title ? `<h3>${escapeHtml(section.title)}</h3>` : ""}
        </div>
      </div>
      <div class="screenshot-report-layout">
        <div class="screenshot-report-media">
          ${section.imageData ? `<img src="${escapeHtml(section.imageData)}" alt="${escapeHtml(section.title || "Review screenshot")}">` : `<div class="empty-state">No screenshot was added.</div>`}
        </div>
        <div class="screenshot-report-copy">
          ${renderSectionBodyText(section, "No screenshot notes were added.")}
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
          ${section.title ? `<h3>${escapeHtml(section.title)}</h3>` : ""}
        </div>
      </div>
      ${renderSectionBodyText(section, "No challenge notes were added.")}
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
          ${section.title ? `<h3>${escapeHtml(section.title)}</h3>` : ""}
        </div>
      </div>
      ${renderBodyText(section.description, "No risk description was added.")}
      <div class="risk-heatmap-row">
        <span>Impact: ${escapeHtml(riskScaleLabel(section.impact))}</span>
        <span>Likelihood: ${escapeHtml(riskScaleLabel(section.likelihood))}</span>
        <span>ROAM: ${escapeHtml(roamStatusLabel(section.roam))}</span>
      </div>
      ${
        section.owner || section.notes
          ? `<div class="risk-owner-notes">
              ${section.owner ? `<span>Owner: ${escapeHtml(section.owner)}</span>` : ""}
              ${section.notes ? `<div class="risk-notes-copy">${renderBodyText(section.notes)}</div>` : ""}
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
          ${section.title ? `<h3>${escapeHtml(section.title)}</h3>` : ""}
        </div>
      </div>
      <div class="ado-report-next-grid${section.stories && section.stories.length > 0 ? "" : " single"}">
        <div class="next-copy-panel">
          ${renderSectionBodyText(section, "No next-step details were added.")}
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
  const hasCustomTitle = section.title && section.title.trim().toLowerCase() !== "live demo";

  return `
    <article class="ado-report-special-card demo-report-card">
      <div class="section-special-heading">
        <span aria-hidden="true">${sectionIcon("live_demo")}</span>
        <div>
          ${hasCustomTitle ? `<h3>${escapeHtml(section.title)}</h3>` : ""}
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
      ${section.note ? renderBodyText(section.note) : ""}
    </article>
  `;
}

function renderAdoReportSection(section, index, nextIteration, metrics = {}) {
  if (isMetricSectionType(section.type)) {
    return renderAdoReportMetricSection(section, metrics);
  }

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

function renderAdoNarrativeSections(sections, nextIteration = null, metrics = {}) {
  if (!sections || sections.length === 0) {
    return `<div class="empty-state">No review sections were added. Return to the builder to add stakeholder-facing context.</div>`;
  }

  return `
    <div class="ado-report-section-stack">
      ${sections.map((section, index) => renderAdoReportSection(section, index, nextIteration, metrics)).join("")}
    </div>
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
      font-family: "Segoe UI", system-ui, Arial, sans-serif;
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
    .ado-report-team-logo {
      background: rgba(255, 255, 255, .94);
      border: 1px solid rgba(255, 255, 255, .72);
      border-radius: 14px;
      box-shadow: 0 22px 46px rgba(16, 33, 44, .22);
      display: block;
      height: 100%;
      max-height: 340px;
      max-width: 100%;
      object-fit: contain;
      padding: 20px;
      width: 100%;
    }
    .ado-report-opening-layout {
      align-items: stretch;
      display: grid;
      gap: 28px;
      grid-template-columns: minmax(0, 60fr) minmax(280px, 40fr);
    }
    .ado-report-logo-panel {
      align-items: center;
      background: rgba(255, 255, 255, .14);
      border: 1px solid rgba(255, 255, 255, .28);
      border-radius: 14px;
      display: flex;
      justify-content: center;
      min-height: 340px;
      padding: 24px;
    }
    .ado-report-logo-panel .ado-report-team-logo {
      width: 100%;
    }
    .ado-report-opening-copy {
      align-content: center;
      display: grid;
      min-width: 0;
    }
    .ado-report-summary {
      margin-top: 22px;
      max-width: 900px;
    }
    .ado-report-summary p,
    .ado-report-summary li {
      font-size: 1.06rem;
      font-weight: 650;
      line-height: 1.65;
    }
    .ado-report-summary p {
      margin: 0;
    }
    .ado-report-summary p + p,
    .ado-report-summary ul + p,
    .ado-report-summary p + ul {
      margin-top: 12px;
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
    .risk-notes-copy {
      flex-basis: 100%;
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
    .business-value-box p,
    .business-value-box li,
    .risk-notes-copy p,
    .risk-notes-copy li {
      color: #3a2a05;
      font-size: 1rem;
      font-weight: 750;
      line-height: 1.55;
      margin: 0;
    }
    .risk-notes-copy p,
    .risk-notes-copy li {
      color: #10212c;
    }
    .business-value-box p + p,
    .business-value-box ul + p,
    .business-value-box p + ul,
    .risk-notes-copy p + p,
    .risk-notes-copy ul + p,
    .risk-notes-copy p + ul {
      margin-top: 10px;
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
      .ado-report-opening-layout,
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

function renderAdoReportTeamLogo(teamLogo) {
  const logo = normalizeTeamLogo(teamLogo);

  return logo.imageData
    ? `<img class="ado-report-team-logo" src="${escapeHtml(logo.imageData)}" alt="Team logo">`
    : "";
}

function renderAdoReportIdentity(result, narrative, metrics, summary) {
  const logo = normalizeTeamLogo(narrative && narrative.teamLogo);
  const identityCopy = `
    <div class="ado-report-opening-copy">
      <span>SprintGen ADO report</span>
      <h1>${escapeHtml(result.iteration.name)}</h1>
      <div class="ado-report-summary">${renderBodyText(summary)}</div>
      <div class="hero-facts">
        <div><span>Team</span><strong>${escapeHtml(result.team)}</strong></div>
        <div><span>Work areas</span><strong>${escapeHtml(areaPathDisplay(normalizeAreaPathList(result.areaPaths, result.areaPath)))}</strong></div>
        <div><span>Dates</span><strong>${escapeHtml(formatDateOnly(result.iteration.startDate))} to ${escapeHtml(formatDateOnly(result.iteration.finishDate))}</strong></div>
      </div>
      ${renderAdoReportContributors(metrics && metrics.contributors)}
    </div>
  `;

  return logo.imageData
    ? `<div class="ado-report-opening-layout">${identityCopy}<div class="ado-report-logo-panel">${renderAdoReportTeamLogo(logo)}</div></div>`
    : identityCopy;
}

function renderAdoReportMetricSection(section, metrics) {
  if (section.type === "agile_metrics") {
    return `
      <article class="ado-report-special-card metric-report-card">
        <div class="section-special-heading"><h3>Agile metrics</h3></div>
        ${renderSprintHealthCards(metrics && metrics.sprintHealthCards)}
      </article>
    `;
  }

  if (section.type === "burndown") {
    return `
      <article class="ado-report-special-card metric-report-card burndown-report-card">
        <div class="section-special-heading"><h3>Burndown</h3></div>
        ${renderBurndownChart(metrics && metrics.selectedBurndown)}
      </article>
    `;
  }

  return `
    <article class="ado-report-special-card metric-report-card">
      <div class="section-special-heading"><h3>Velocity</h3></div>
      <h3>Last 3 completed sprints</h3>
      ${renderVelocityBars(metrics && metrics.velocity)}
    </article>
  `;
}

function renderAdoReportHtml(report) {
  const result = report.result || report;
  const narrative = report.narrative || {};
  const metrics = result.metrics || {};
  const summary = narrative.summary || defaultSummaryText(result);
  const generatedAt = report.generatedAt || new Date().toISOString().slice(0, 10);
  const nextIteration = report.nextIteration || null;
  const narrativeSections = sectionsForGeneratedOutput(narrative, result);

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
      ${renderAdoReportIdentity(result, narrative, metrics, summary)}
    </header>

    <section class="ado-report-section">
      <div>
        <span>Review story</span>
        <h2>Highlights, metrics, screenshots, challenges, risks, and next steps</h2>
      </div>
      ${renderAdoNarrativeSections(narrativeSections, nextIteration, metrics)}
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

function getSprintLabel(iterationPath) {
  const parts = String(iterationPath || "").split("\\").filter(Boolean);
  return parts[parts.length - 1] || "Sprint";
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
        ${section.priority ? `<span class="present-kicker">#1 priority</span>` : ""}
        ${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ""}
        <div class="present-narrative-grid single delivery-update-layout">
          <div class="present-copy-block">
            ${renderSectionBodyText(section, "No body text was added for this update.")}
            ${
              section.stories && section.stories.length > 0
                ? `<div class="delivery-story-pill">${renderStoryChips(section.stories)}</div>`
                : ""
            }
            ${
              section.businessValue
                ? `<div class="present-business-value"><span>Business Value</span>${renderBodyText(section.businessValue)}</div>`
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
        ${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ""}
        <div class="present-screenshot-layout">
          <div class="present-screenshot-media">
            ${section.imageData ? `<img src="${escapeHtml(section.imageData)}" alt="${escapeHtml(section.title || "Review screenshot")}">` : `<p class="present-empty">No screenshot was added.</p>`}
          </div>
          <div class="present-copy-block">
            ${renderSectionBodyText(section, "No screenshot notes were added.")}
            ${
              section.businessValue
                ? `<div class="present-business-value"><span>Business Value</span>${renderBodyText(section.businessValue)}</div>`
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
        <div class="present-special-heading">
          <span aria-hidden="true">${sectionIcon("challenge")}</span>
          ${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ""}
        </div>
        <div class="present-copy-block">
          ${renderSectionBodyText(section, "No challenge notes were added.")}
          ${
            section.businessValue
              ? `<div class="present-business-value"><span>Response</span>${renderBodyText(section.businessValue)}</div>`
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
        <div class="present-special-heading">
          <span aria-hidden="true">${sectionIcon("risk")}</span>
          ${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ""}
        </div>
        <div class="present-risk-grid">
          <div class="present-copy-block">
            ${renderBodyText(section.description, "No risk description was added.")}
            ${
              section.owner || section.notes
                ? `<div class="present-risk-notes">
                    ${section.owner ? `<span>Owner: ${escapeHtml(section.owner)}</span>` : ""}
                    ${section.notes ? renderBodyText(section.notes) : ""}
                  </div>`
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
        ${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ""}
        <div class="present-narrative-grid${section.stories && section.stories.length > 0 ? "" : " single"}">
          <div class="present-copy-block">
            ${renderSectionBodyText(section, "No next-step details were added.")}
            ${
              section.businessValue
                ? `<div class="present-business-value"><span>Context</span>${renderBodyText(section.businessValue)}</div>`
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

function renderAdoPresentationSectionSlides(sections, nextIteration = null, metrics = {}) {
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

      if (isMetricSectionType(section.type)) {
        return renderAdoPresentationMetricSlide(section, metrics);
      }

      return renderAdoPresentationDeliverySlide(section, index);
    })
    .join("");
}

function renderAdoPresentationMetricSlide(section, metrics = {}) {
  if (section.type === "agile_metrics") {
    return `
      <section class="ado-present-slide">
        <div class="present-card label-only">
          ${renderSprintHealthCards(metrics.sprintHealthCards)}
        </div>
      </section>
    `;
  }

  if (section.type === "burndown") {
    return `
      <section class="ado-present-slide burndown-slide">
        <div class="present-card wide label-only">
          ${renderBurndownChart(metrics.selectedBurndown)}
        </div>
      </section>
    `;
  }

  return `
    <section class="ado-present-slide">
      <div class="present-card wide">
        <h2>Last 3 completed sprints</h2>
        ${renderVelocityBars(metrics.velocity)}
      </div>
    </section>
  `;
}

function renderAdoPresentationTeamLogo(teamLogo) {
  const logo = normalizeTeamLogo(teamLogo);

  return logo.imageData
    ? `<img class="present-team-logo" src="${escapeHtml(logo.imageData)}" alt="Team logo">`
    : "";
}

function renderAdoPresentationIdentity(result, narrative, metrics) {
  const logo = normalizeTeamLogo(narrative && narrative.teamLogo);
  const details = `
    <dl>
      <div><dt>Dates</dt><dd>${escapeHtml(formatDateOnly(result.iteration.startDate))} to ${escapeHtml(formatDateOnly(result.iteration.finishDate))}</dd></div>
      <div><dt>Work areas</dt><dd>${escapeHtml(areaPathDisplay(normalizeAreaPathList(result.areaPaths, result.areaPath)))}</dd></div>
      <div><dt>Project</dt><dd>${escapeHtml(result.config.project)}</dd></div>
    </dl>
    ${renderPresentationContributors(metrics && metrics.contributors)}
  `;
  const identityCopy = `
    <div class="present-opening-copy">
      <span class="present-kicker">Sprint Recap</span>
      <h1>${escapeHtml(result.iteration.name)}</h1>
      <p>${escapeHtml(result.team)}</p>
      ${details}
    </div>
  `;

  return logo.imageData
    ? `<div class="present-opening-layout">${identityCopy}<div class="present-logo-panel">${renderAdoPresentationTeamLogo(logo)}</div></div>`
    : identityCopy;
}

function renderAdoPresentationDemoSlide(demo) {
  if (!demo || !demo.enabled) {
    return "";
  }

  const presenters = Array.isArray(demo.presenters) ? demo.presenters : [];
  const demoTitle = demo.title || "Live Demo";
  const presentationTitle = demoTitle.trim().toLowerCase() === "live demo" ? "Demo" : demoTitle;

  return `
    <section class="ado-present-slide demo-handoff-slide">
      <div class="present-card demo-handoff-card">
        <h2>${escapeHtml(presentationTitle)}</h2>
        ${
          presenters.length > 0
            ? `<div class="demo-presenter-chips">
                ${presenters.map((presenter) => `<span>${escapeHtml(presenter)}</span>`).join("")}
              </div>`
            : ""
        }
        ${demo.note ? renderBodyText(demo.note) : ""}
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

function renderPresentationFullscreenButton() {
  const maximizePath = "M3 5c0-1.1.9-2 2-2h2a.5.5 0 0 1 0 1H5a1 1 0 0 0-1 1v2a.5.5 0 0 1-1 0zm9.5-1.5c0-.28.22-.5.5-.5h2a2 2 0 0 1 2 2v2a.5.5 0 0 1-1 0V5a1 1 0 0 0-1-1h-2a.5.5 0 0 1-.5-.5m-9 9c.28 0 .5.22.5.5v2a1 1 0 0 0 1 1h2a.5.5 0 0 1 0 1H5a2 2 0 0 1-2-2v-2c0-.28.22-.5.5-.5m13 0c.28 0 .5.22.5.5v2a2 2 0 0 1-2 2h-2a.5.5 0 0 1 0-1h2a1 1 0 0 0 1-1v-2c0-.28.22-.5.5-.5";
  const minimizePath = "M14 5a1 1 0 0 0 1 1h2a.5.5 0 0 1 0 1h-2a2 2 0 0 1-2-2V3a.5.5 0 0 1 1 0zM6 15a1 1 0 0 0-1-1H3a.5.5 0 0 1 0-1h2a2 2 0 0 1 2 2v2a.5.5 0 0 1-1 0zm8 0a1 1 0 0 1 1-1h2a.5.5 0 0 0 0-1h-2a2 2 0 0 0-2 2v2a.5.5 0 0 0 1 0zM5 6a1 1 0 0 0 1-1V3a.5.5 0 0 1 1 0v2a2 2 0 0 1-2 2H3a.5.5 0 0 1 0-1z";
  return `
    <button class="present-fullscreen" type="button" data-fullscreen aria-label="Enter full screen" aria-pressed="false" title="Enter full screen">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path data-fullscreen-icon data-maximize-path="${maximizePath}" data-minimize-path="${minimizePath}" fill="currentColor" stroke="none" d="${maximizePath}"></path>
      </svg>
    </button>
  `;
}

function renderFloatingLinesPresentationPage(result, slidesHtml) {
  const title = result && result.iteration && result.iteration.name ? result.iteration.name : "Sprint Spotlight";

  return `<!DOCTYPE html>
<html class="floating-lines-document" lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#ffffff" />
  <title>${escapeHtml(title)} - Floating Lines Mode</title>
  <link rel="stylesheet" href="/assets/vendor/reveal/reveal.css?v=6.0.0">
  <link rel="stylesheet" href="/assets/ado-present.css?v=24">
  <link rel="stylesheet" href="/assets/spotlight-present.css?v=8">
</head>
<body class="vibe-spotlight vibe-floating-lines">
  <div class="floating-lines-background" data-floating-lines aria-hidden="true"></div>
  <div class="floating-lines-scrim" aria-hidden="true"></div>
  ${renderPresentationFullscreenButton()}
  <main class="reveal" aria-label="Floating Lines presentation">
    <div class="slides">
      ${slidesHtml}
    </div>
  </main>
  <nav class="spotlight-controls" aria-label="Presentation controls">
    <button type="button" data-spotlight-prev aria-label="Previous slide" title="Previous slide">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
    </button>
    <button type="button" data-spotlight-next aria-label="Next slide" title="Next slide">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
    </button>
  </nav>
  <script src="/assets/vendor/reveal/reveal.js?v=6.0.0"></script>
  <script type="module" src="/assets/spotlight-present.js?v=12"></script>
</body>
</html>`;
}

function renderIridescencePresentationPage(result, slidesHtml) {
  const title = result && result.iteration && result.iteration.name ? result.iteration.name : "Sprint Spotlight";

  return `<!DOCTYPE html>
<html class="spotlight-document iridescence-document" lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#06b6d4" />
  <title>${escapeHtml(title)} - Iridescence Mode</title>
  <link rel="stylesheet" href="/assets/vendor/reveal/reveal.css?v=6.0.0">
  <link rel="stylesheet" href="/assets/ado-present.css?v=24">
  <link rel="stylesheet" href="/assets/spotlight-present.css?v=8">
  <link rel="stylesheet" href="/assets/iridescence-present.css?v=2">
</head>
<body class="vibe-spotlight vibe-iridescence">
  <div class="iridescence-background" data-iridescence aria-hidden="true"></div>
  ${renderPresentationFullscreenButton()}
  <main class="reveal" aria-label="Iridescence presentation">
    <div class="slides">
      ${slidesHtml}
    </div>
  </main>
  <nav class="spotlight-controls" aria-label="Presentation controls">
    <button type="button" data-spotlight-prev aria-label="Previous slide" title="Previous slide">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
    </button>
    <button type="button" data-spotlight-next aria-label="Next slide" title="Next slide">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
    </button>
  </nav>
  <script src="/assets/vendor/reveal/reveal.js?v=6.0.0"></script>
  <script type="module" src="/assets/spotlight-present.js?v=12"></script>
</body>
</html>`;
}

function renderAdoPresentationPage(report, vibeInput) {
  const result = report.result || report;
  const narrative = report.narrative || null;
  const nextIteration = report.nextIteration || null;
  const metrics = result.metrics || {};
  const presentationOptions = vibeInput && typeof vibeInput === "object"
    ? vibeInput
    : { vibe: vibeInput };
  const vibe = normalizePresentationVibe(presentationOptions.vibe);
  const requestedColor = canonicalPresentationColor(presentationOptions.color);
  const savedColor = canonicalPresentationColor(report.presentation && report.presentation.color);
  const colorTokens = buildPresentationColorTokens(requestedColor || savedColor);
  const completedItems = metrics.items ? metrics.items.completed : [];
  const summary = narrative && narrative.summary ? narrative.summary : defaultSummaryText(result);
  const narrativeSections = narrative ? sectionsForGeneratedOutput(narrative, result) : [];
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
          <div class="present-summary">${renderBodyText(summary)}</div>
        </div>
      </section>
    `
    : "";
  const narrativeSlides = narrative
    ? `
      ${renderAdoPresentationSectionSlides(narrativeSections, nextIteration, metrics)}
      ${renderAdoPresentationReadinessSlide(narrative.environmentReadiness)}
    `
    : `
      ${renderAdoPresentationSectionSlides(createDefaultMetricSections(), null, metrics)}
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

  const slidesHtml = `
    <section class="ado-present-slide opening">
      ${presentationBrandRailTop}
      <div class="present-card present-opening-card">
        ${renderAdoPresentationIdentity(result, narrative, metrics)}
      </div>
    </section>

    ${openingRemarksSlide}
    ${narrativeSlides}
    ${closingSlide}
  `;

  if (vibe === "floating-lines") {
    return renderFloatingLinesPresentationPage(result, slidesHtml);
  }

  if (vibe === "iridescence") {
    return renderIridescencePresentationPage(result, slidesHtml);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="${escapeHtml(vibe === "color" ? colorTokens.color : "#f8fcff")}" />
  <title>${escapeHtml(result.iteration.name)} - ADO Presentation</title>
  <link rel="stylesheet" href="/assets/ado-present.css?v=24">
</head>
<body class="vibe-${escapeHtml(vibe)}"${vibe === "color" ? ` style="--deck-color:${colorTokens.color};--deck-on-color:${colorTokens.onColor};--deck-surface-mix:${colorTokens.surfaceMix}"` : ""}>
  <div class="present-progress" aria-hidden="true"><span></span></div>
  ${renderPresentationFullscreenButton()}
  <main class="ado-present-deck" data-deck>
    ${slidesHtml}
  </main>
  <nav class="present-controls" aria-label="Presentation controls">
    <button type="button" data-prev aria-label="Previous slide">&#8592;</button>
    <button type="button" data-next aria-label="Next slide">&#8594;</button>
  </nav>
  <script src="/assets/ado-present.js?v=13"></script>
</body>
</html>`;
}

async function buildAdoDataPreview({ team, sprint, areaPath = "", areaPaths = [] }) {
  const selectedAreaPaths = normalizeAreaPathList(areaPaths, areaPath);
  const selectedAreaPath = primaryAreaPath(selectedAreaPaths);
  const iterationsResult = await listTeamIterations({
    org: adoConfig.org,
    project: adoConfig.project,
    team
  });
  const iteration = resolveIterationInput(sprint, iterationsResult.iterations);
  const metadata = await fetchAnalyticsMetadata({
    org: adoConfig.org,
    project: adoConfig.project
  });
  const burndownRows = await queryIterationSnapshotRowsForAreas({
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
    source: "ado",
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

const { registerCloudRoutes } = require("./cloudRoutes");
const artifactEngine = createArtifactEngine({
  htmlRenderer: renderAdoReportHtml,
  presentationRenderer: renderAdoPresentationPage,
  pdfGenerator: exportPdf
});

registerCloudRoutes(app, {
  projectRoot,
  adoConfig,
  reviewStore,
  attachRequestContext,
  requireApiUser,
  requireSameOrigin,
  listProjectTeams,
  listTeamIterations,
  listTeamAreaPaths,
  buildAdoReviewDraft,
  buildManualReviewDraft,
  buildDraftFromSavedReview,
  createSavedReviewFromReport,
  remapNarrativeStories,
  normalizeStoryItems,
  normalizeNarrativeSections,
  createDefaultMetricSections,
  isMetricSectionType,
  normalizeEnvironmentReadiness,
  normalizeTeamLogo,
  normalizePresentationColor,
  isValidPresentationColor,
  stripSensitiveReviewKeys,
  defaultSummaryText,
  renderHtmlReport: artifactEngine.renderHtmlReport,
  renderPresentation: artifactEngine.renderPresentation,
  generatePdf: artifactEngine.generatePdf,
  getHtmlDownloadName
});

if (require.main === module) {
  const server = app.listen(port, () => {
    logEvent("info", "server_started", { port: Number(port), environment: process.env.NODE_ENV || "development" });
  });

  function shutdown(signal) {
    logEvent("info", "server_shutdown_started", { signal });
    server.close((error) => {
      if (error) {
        logEvent("error", "server_shutdown_failed", { signal, detail: error.message });
        process.exitCode = 1;
      } else {
        logEvent("info", "server_shutdown_complete", { signal });
      }
    });
    setTimeout(() => {
      logEvent("error", "server_shutdown_timeout", { signal });
      process.exit(1);
    }, 25000).unref();
  }

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

module.exports = {
  app,
  normalizeStoryItems,
  renderHtmlReport: artifactEngine.renderHtmlReport,
  renderPresentation: artifactEngine.renderPresentation
};
