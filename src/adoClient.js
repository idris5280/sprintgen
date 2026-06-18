const DEFAULT_ORG = "esiappdev";
const DEFAULT_PROJECT = "Digital Transformation";

class AdoError extends Error {
  constructor(message, { status = 500, code = "ADO_ERROR", detail = "" } = {}) {
    super(message);
    this.name = "AdoError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function getAdoConfig() {
  return {
    org: process.env.ADO_ORG || DEFAULT_ORG,
    project: process.env.ADO_PROJECT || DEFAULT_PROJECT
  };
}

function assertPat(pat) {
  if (!pat || !String(pat).trim()) {
    throw new AdoError("Enter an Azure DevOps PAT to run the feasibility test.", {
      status: 400,
      code: "MISSING_PAT"
    });
  }
}

function createAuthHeaders(pat, accept = "application/json") {
  assertPat(pat);

  return {
    Authorization: `Basic ${Buffer.from(`:${String(pat).trim()}`, "utf8").toString("base64")}`,
    Accept: accept
  };
}

function encodeSegment(value) {
  return encodeURIComponent(String(value || ""));
}

function escapeODataString(value) {
  return String(value || "").replace(/'/g, "''");
}

function escapeWiqlString(value) {
  return String(value || "").replace(/'/g, "''");
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function buildDevOpsBaseUrl({ org, project }) {
  return `https://dev.azure.com/${encodeSegment(org)}/${encodeSegment(project)}`;
}

function buildDevOpsOrgBaseUrl({ org }) {
  return `https://dev.azure.com/${encodeSegment(org)}`;
}

function buildAnalyticsBaseUrl({ org, project }) {
  return `https://analytics.dev.azure.com/${encodeSegment(org)}/${encodeSegment(project)}/_odata/v3.0-preview`;
}

async function parseResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

function extractErrorMessage(body) {
  if (!body) {
    return "";
  }

  if (typeof body === "string") {
    return body.slice(0, 500);
  }

  return (
    (body.error && (body.error.message || body.error.code)) ||
    body.message ||
    body.typeKey ||
    ""
  );
}

function friendlyStatusMessage(status, fallback) {
  if (status === 401) {
    return "Azure DevOps rejected the PAT. Confirm the token is active, copied correctly, and scoped to the esiappdev organization.";
  }

  if (status === 403) {
    return "Azure DevOps accepted the request but blocked access. The PAT user likely needs read access to work items, teams, or Analytics.";
  }

  if (status === 404) {
    return "Azure DevOps could not find that team, sprint, project, or Analytics resource. Check the team name and sprint value.";
  }

  return fallback || "Azure DevOps returned an unexpected response.";
}

async function requestJson(url, { pat, method = "GET", body } = {}) {
  const headers = createAuthHeaders(pat);

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const parsedBody = await parseResponseBody(response);

  if (!response.ok) {
    throw new AdoError(friendlyStatusMessage(response.status), {
      status: response.status,
      code: "ADO_HTTP_ERROR",
      detail: extractErrorMessage(parsedBody)
    });
  }

  return parsedBody;
}

async function listProjectTeams({ pat, org, project }) {
  const baseUrl = buildDevOpsOrgBaseUrl({ org });
  const url = `${baseUrl}/_apis/projects/${encodeSegment(project)}/teams?$top=500&api-version=7.1`;
  const response = await requestJson(url, { pat });
  const teams = Array.isArray(response.value) ? response.value : [];

  return {
    count: teams.length,
    teams: teams
      .map((team) => ({
        id: team.id || "",
        name: team.name || "",
        description: team.description || "",
        projectName: team.projectName || project
      }))
      .filter((team) => team.name)
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

async function requestText(url, { pat } = {}) {
  const response = await fetch(url, {
    headers: createAuthHeaders(pat, "application/xml,text/xml,*/*")
  });

  const body = await response.text();

  if (!response.ok) {
    throw new AdoError(friendlyStatusMessage(response.status), {
      status: response.status,
      code: "ADO_HTTP_ERROR",
      detail: body.slice(0, 500)
    });
  }

  return {
    status: response.status,
    body
  };
}

async function listTeamIterations({ pat, org, project, team }) {
  if (!team || !String(team).trim()) {
    throw new AdoError("Enter a team name before running the feasibility test.", {
      status: 400,
      code: "MISSING_TEAM"
    });
  }

  const baseUrl = buildDevOpsBaseUrl({ org, project });
  const url = `${baseUrl}/${encodeSegment(team)}/_apis/work/teamsettings/iterations?api-version=7.1`;
  const response = await requestJson(url, { pat });

  return {
    count: Array.isArray(response.value) ? response.value.length : 0,
    iterations: Array.isArray(response.value) ? response.value : []
  };
}

async function listTeamAreaPaths({ pat, org, project, team }) {
  if (!team || !String(team).trim()) {
    throw new AdoError("Enter a team name before loading area paths.", {
      status: 400,
      code: "MISSING_TEAM"
    });
  }

  const baseUrl = buildDevOpsBaseUrl({ org, project });
  const url = `${baseUrl}/${encodeSegment(team)}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`;
  const response = await requestJson(url, { pat });
  const values = Array.isArray(response.values) ? response.values : [];
  const areas = values
    .map((area) => ({
      value: area.value || "",
      includeChildren: Boolean(area.includeChildren)
    }))
    .filter((area) => area.value);

  return {
    defaultValue: response.defaultValue || (areas[0] && areas[0].value) || "",
    count: areas.length,
    areas
  };
}

function normalizeInput(value) {
  return String(value || "").trim();
}

function normalizeCompare(value) {
  return normalizeInput(value).toLowerCase();
}

function getSprintNameFromPath(path) {
  const parts = normalizeInput(path).split("\\").filter(Boolean);
  return parts[parts.length - 1] || normalizeInput(path);
}

function resolveIterationInput(sprintInput, iterations) {
  const input = normalizeInput(sprintInput);

  if (!input) {
    throw new AdoError("Enter a sprint number or full iteration path.", {
      status: 400,
      code: "MISSING_SPRINT"
    });
  }

  const sprintName = /^\d+$/.test(input) ? `Sprint ${input}` : input;
  const inputCompare = normalizeCompare(input);
  const sprintNameCompare = normalizeCompare(sprintName);

  const match = iterations.find((iteration) => {
    const name = normalizeCompare(iteration.name);
    const path = normalizeCompare(iteration.path);

    return (
      name === inputCompare ||
      name === sprintNameCompare ||
      path === inputCompare ||
      path.endsWith(`\\${sprintNameCompare}`)
    );
  });

  if (!match) {
    throw new AdoError(`Sprint "${input}" was not found for the selected team. Try the sprint number, such as 37, or paste the full iteration path.`, {
      status: 404,
      code: "SPRINT_NOT_FOUND"
    });
  }

  return {
    id: match.id || "",
    name: match.name || getSprintNameFromPath(match.path),
    path: match.path,
    startDate: match.attributes && match.attributes.startDate ? match.attributes.startDate : "",
    finishDate: match.attributes && match.attributes.finishDate ? match.attributes.finishDate : "",
    timeFrame: match.attributes && match.attributes.timeFrame ? match.attributes.timeFrame : ""
  };
}

async function fetchAnalyticsMetadata({ pat, org, project }) {
  const url = `${buildAnalyticsBaseUrl({ org, project })}/$metadata`;
  const response = await requestText(url, { pat });

  return {
    status: response.status,
    hasWorkItemSnapshot: response.body.includes("WorkItemSnapshot"),
    hasWorkItems: response.body.includes("WorkItems"),
    byteLength: Buffer.byteLength(response.body, "utf8")
  };
}

function buildAreaAnalyticsFilter(areaPath) {
  return areaPath ? ` and Area/AreaPath eq '${escapeODataString(areaPath)}'` : "";
}

function buildAreaWiqlFilter(areaPath) {
  return areaPath ? `AND [System.AreaPath] = '${escapeWiqlString(areaPath)}'` : "";
}

function uniqueValues(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeFieldName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function listWorkItemFields({ pat, org, project }) {
  const baseUrl = buildDevOpsBaseUrl({ org, project });
  const url = `${baseUrl}/_apis/wit/fields?api-version=7.1`;
  const response = await requestJson(url, { pat });

  return Array.isArray(response.value) ? response.value : [];
}

async function discoverTestedByFieldReferences({ pat, org, project }) {
  const configured = uniqueValues([process.env.ADO_TESTED_BY_FIELD]);
  const fields = await listWorkItemFields({ pat, org, project });
  const discovered = fields
    .filter((field) => {
      const displayName = normalizeFieldName(field.name);
      const referenceName = normalizeFieldName(field.referenceName);

      return displayName === "testedby" || referenceName.endsWith("testedby");
    })
    .map((field) => field.referenceName);

  return uniqueValues([...configured, ...discovered]);
}

async function queryStoryPointBurndown({ pat, org, project, team, iterationPath, areaPath = "" }) {
  const apply = [
    "filter(",
    "WorkItemType eq 'User Story'",
    ` and Teams/any(x:x/TeamName eq '${escapeODataString(team)}')`,
    buildAreaAnalyticsFilter(areaPath),
    ` and Iteration/IterationPath eq '${escapeODataString(iterationPath)}'`,
    " and DateValue ge Iteration/StartDate",
    " and DateValue le Iteration/EndDate",
    ")",
    "/groupby(",
    "(DateValue,State,Iteration/IterationPath),",
    "aggregate($count as Count,StoryPoints with sum as TotalStoryPoints)",
    ")"
  ].join("");

  const url = new URL(`${buildAnalyticsBaseUrl({ org, project })}/WorkItemSnapshot`);
  url.searchParams.set("$apply", apply);

  const response = await requestJson(url.toString(), { pat });
  return Array.isArray(response.value) ? response.value : [];
}

async function queryIterationSnapshotRows({ pat, org, project, team, iterationPath, areaPath = "" }) {
  const applyWithStateCategory = [
    "filter(",
    "WorkItemType eq 'User Story'",
    ` and Teams/any(x:x/TeamName eq '${escapeODataString(team)}')`,
    buildAreaAnalyticsFilter(areaPath),
    ` and Iteration/IterationPath eq '${escapeODataString(iterationPath)}'`,
    " and DateValue ge Iteration/StartDate",
    " and DateValue le Iteration/EndDate",
    ")",
    "/groupby(",
    "(DateValue,State,StateCategory,Iteration/IterationPath),",
    "aggregate($count as Count,StoryPoints with sum as TotalStoryPoints)",
    ")"
  ].join("");

  const url = new URL(`${buildAnalyticsBaseUrl({ org, project })}/WorkItemSnapshot`);
  url.searchParams.set("$apply", applyWithStateCategory);

  try {
    const response = await requestJson(url.toString(), { pat });
    return Array.isArray(response.value) ? response.value : [];
  } catch (error) {
    const fallbackRows = await queryStoryPointBurndown({ pat, org, project, team, iterationPath, areaPath });
    fallbackRows.fallbackReason = error.message;
    return fallbackRows;
  }
}

async function queryIterationWorkItemsFromAnalytics({
  pat,
  org,
  project,
  team,
  iterationPath,
  areaPath = "",
  includeStateCategory = true,
  includeAssignedTo = true
}) {
  const url = new URL(`${buildAnalyticsBaseUrl({ org, project })}/WorkItems`);
  const selectFields = [
    "WorkItemId",
    "Title",
    "State",
    "WorkItemType",
    "StoryPoints",
    "CreatedDate",
    "ChangedDate",
    "Tags"
  ];

  if (includeAssignedTo) {
    selectFields.push("AssignedTo");
  }

  if (includeStateCategory) {
    selectFields.splice(3, 0, "StateCategory");
  }

  url.searchParams.set(
    "$filter",
    `Teams/any(x:x/TeamName eq '${escapeODataString(team)}')${buildAreaAnalyticsFilter(areaPath)} and Iteration/IterationPath eq '${escapeODataString(iterationPath)}'`
  );
  url.searchParams.set("$select", selectFields.join(","));
  url.searchParams.set("$orderby", "WorkItemType,WorkItemId");
  url.searchParams.set("$top", "1000");

  const response = await requestJson(url.toString(), { pat });

  return {
    source: "Analytics WorkItems",
    count: Array.isArray(response.value) ? response.value.length : 0,
    items: Array.isArray(response.value) ? response.value : []
  };
}

async function queryCurrentSprintWorkItemsFromAnalytics({ pat, org, project, team, iterationPath, areaPath = "", includeAssignedTo = true }) {
  const url = new URL(`${buildAnalyticsBaseUrl({ org, project })}/WorkItems`);
  const selectFields = ["WorkItemId", "Title", "State", "WorkItemType", "StoryPoints"];

  if (includeAssignedTo) {
    selectFields.push("AssignedTo");
  }

  url.searchParams.set(
    "$filter",
    `Teams/any(x:x/TeamName eq '${escapeODataString(team)}')${buildAreaAnalyticsFilter(areaPath)} and Iteration/IterationPath eq '${escapeODataString(iterationPath)}'`
  );
  url.searchParams.set("$select", selectFields.join(","));
  url.searchParams.set("$orderby", "WorkItemType,WorkItemId");
  url.searchParams.set("$top", "50");

  const response = await requestJson(url.toString(), { pat });

  return {
    source: "Analytics WorkItems",
    count: Array.isArray(response.value) ? response.value.length : 0,
    items: Array.isArray(response.value) ? response.value : []
  };
}

async function queryCurrentSprintWorkItemsFromWiql({ pat, org, project, iterationPath, areaPath = "", extraFields = [] }) {
  const baseUrl = buildDevOpsBaseUrl({ org, project });
  const wiqlUrl = `${baseUrl}/_apis/wit/wiql?api-version=7.1`;
  const selectFields = ["[System.Id]", "[System.Title]", "[System.State]", "[System.WorkItemType]", "[System.AssignedTo]"];
  const batchFields = uniqueValues([
    "System.Id",
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.AssignedTo",
    "Microsoft.VSTS.Scheduling.StoryPoints",
    ...extraFields
  ]);

  const query = [
    `SELECT ${selectFields.join(", ")}`,
    "FROM WorkItems",
    `WHERE [System.TeamProject] = '${escapeWiqlString(project)}'`,
    buildAreaWiqlFilter(areaPath),
    `AND [System.IterationPath] = '${escapeWiqlString(iterationPath)}'`,
    "ORDER BY [System.WorkItemType], [System.Id]"
  ].filter(Boolean).join(" ");

  const wiql = await requestJson(wiqlUrl, {
    pat,
    method: "POST",
    body: { query }
  });

  const ids = Array.isArray(wiql.workItems) ? wiql.workItems.map((item) => item.id) : [];

  if (ids.length === 0) {
    return {
      source: "WIQL",
      count: 0,
      items: []
    };
  }

  const batchUrl = `${baseUrl}/_apis/wit/workitemsbatch?api-version=7.1`;
  const items = [];

  for (const idChunk of chunkArray(ids, 200)) {
    const batch = await requestJson(batchUrl, {
      pat,
      method: "POST",
      body: {
        ids: idChunk,
        fields: batchFields
      }
    });

    items.push(...(Array.isArray(batch.value) ? batch.value : []));
  }

  return {
    source: "WIQL",
    count: ids.length,
    items
  };
}

function getWorkItemId(item) {
  const fields = item && item.fields ? item.fields : {};
  return String((item && (item.WorkItemId || item.id)) || fields["System.Id"] || "").trim();
}

function getAssignedToValue(item) {
  const fields = item && item.fields ? item.fields : {};
  return (item && (item.AssignedTo || item.assignedTo)) || fields["System.AssignedTo"] || "";
}

function getTestedByValue(item, fieldRefs = []) {
  const fields = item && item.fields ? item.fields : {};
  const directValue = item && (item.TestedBy || item.testedBy);

  if (directValue) {
    return directValue;
  }

  for (const fieldRef of fieldRefs) {
    if (fields[fieldRef]) {
      return fields[fieldRef];
    }
  }

  return (
    fields.TestedBy ||
    fields["Custom.TestedBy"] ||
    fields["Microsoft.VSTS.Common.TestedBy"] ||
    fields["Microsoft.VSTS.CMMI.TestedBy"] ||
    Object.entries(fields).find(([key, value]) => normalizeFieldName(key).endsWith("testedby") && value)?.[1] ||
    ""
  );
}

function countAssignedItems(items) {
  return (items || []).filter((item) => Boolean(getAssignedToValue(item))).length;
}

function countContributorFieldItems(items, testedByFieldRefs = []) {
  return (items || []).filter((item) => Boolean(getAssignedToValue(item) || getTestedByValue(item, testedByFieldRefs))).length;
}

function appendResultWarning(result, warning) {
  if (!warning) {
    return;
  }

  result.warning = result.warning ? `${result.warning} ${warning}` : warning;
}

async function enrichWorkItemsWithAssignedTo(result, { pat, org, project, iterationPath, areaPath = "", missingWarning = "" }) {
  const items = Array.isArray(result.items) ? result.items : [];

  if (items.length === 0) {
    return result;
  }

  let testedByFieldRefs = [];

  try {
    testedByFieldRefs = await discoverTestedByFieldReferences({ pat, org, project });
  } catch (error) {
    result.testedByFieldDiscoveryError = error.message;
  }

  const needsAssignedTo = countAssignedItems(items) !== items.length;
  const canRequestTestedBy = testedByFieldRefs.length > 0;

  if (!needsAssignedTo && !canRequestTestedBy) {
    return result;
  }

  try {
    const wiqlResult = await queryCurrentSprintWorkItemsFromWiql({
      pat,
      org,
      project,
      iterationPath,
      areaPath,
      extraFields: testedByFieldRefs
    });
    const assignedById = new Map();
    const testedById = new Map();

    for (const item of wiqlResult.items || []) {
      const id = getWorkItemId(item);
      const assignedTo = getAssignedToValue(item);
      const testedBy = getTestedByValue(item, testedByFieldRefs);

      if (id && assignedTo) {
        assignedById.set(id, assignedTo);
      }

      if (id && testedBy) {
        testedById.set(id, testedBy);
      }
    }

    if (assignedById.size > 0 || testedById.size > 0) {
      result.items = items.map((item) => {
        const updates = {};
        const assignedTo = assignedById.get(getWorkItemId(item));
        const testedBy = testedById.get(getWorkItemId(item));

        if (assignedTo && !getAssignedToValue(item)) {
          updates.AssignedTo = assignedTo;
        }

        if (testedBy && !getTestedByValue(item, testedByFieldRefs)) {
          updates.TestedBy = testedBy;
        }

        return Object.keys(updates).length > 0 ? { ...item, ...updates } : item;
      });

      if (assignedById.size > 0) {
        result.assignedToSource = "WIQL System.AssignedTo";
      }

      if (testedById.size > 0) {
        result.testedBySource = `WIQL ${testedByFieldRefs.join(", ")}`;
      }
    }

    if (countContributorFieldItems(result.items, testedByFieldRefs) === 0) {
      appendResultWarning(result, missingWarning || "Contributor names were not returned from Assigned To or Tested By fields for the selected sprint work items.");
    }
  } catch (error) {
    result.assignedToError = error.message;
    appendResultWarning(result, missingWarning || "Contributor names could not be loaded from WIQL for the selected sprint work items.");
  }

  return result;
}

async function queryCurrentSprintWorkItems({ pat, org, project, team, iterationPath, areaPath = "" }) {
  try {
    const result = await queryCurrentSprintWorkItemsFromAnalytics({ pat, org, project, team, iterationPath, areaPath });
    return await enrichWorkItemsWithAssignedTo(result, { pat, org, project, iterationPath, areaPath });
  } catch (error) {
    try {
      const fallback = await queryCurrentSprintWorkItemsFromAnalytics({
        pat,
        org,
        project,
        team,
        iterationPath,
        areaPath,
        includeAssignedTo: false
      });
      fallback.analyticsError = error.message;
      return await enrichWorkItemsWithAssignedTo(fallback, {
        pat,
        org,
        project,
        iterationPath,
        areaPath,
        missingWarning: "Analytics WorkItems did not expose AssignedTo, and WIQL could not fill it for the sample list."
      });
    } catch (secondError) {
      const fallback = await queryCurrentSprintWorkItemsFromWiql({ pat, org, project, iterationPath, areaPath });
      fallback.warning = "Analytics WorkItems did not return cleanly, so SprintGen used a WIQL fallback scoped to the iteration.";
      fallback.analyticsError = secondError.message;
      return fallback;
    }
  }
}

async function queryIterationWorkItems({ pat, org, project, team, iterationPath, areaPath = "" }) {
  try {
    const result = await queryIterationWorkItemsFromAnalytics({ pat, org, project, team, iterationPath, areaPath });
    return await enrichWorkItemsWithAssignedTo(result, { pat, org, project, iterationPath, areaPath });
  } catch (error) {
    try {
      const fallback = await queryIterationWorkItemsFromAnalytics({
        pat,
        org,
        project,
        team,
        iterationPath,
        areaPath,
        includeAssignedTo: false
      });
      fallback.analyticsError = error.message;
      return await enrichWorkItemsWithAssignedTo(fallback, {
        pat,
        org,
        project,
        iterationPath,
        areaPath,
        missingWarning: "Analytics WorkItems did not expose AssignedTo, and WIQL could not fill contributor names for this sprint."
      });
    } catch (assignedToError) {
      try {
        const fallback = await queryIterationWorkItemsFromAnalytics({
          pat,
          org,
          project,
          team,
          iterationPath,
          areaPath,
          includeStateCategory: false
        });
        fallback.warning = "Analytics WorkItems did not expose StateCategory, so SprintGen used state names for completion checks.";
        fallback.analyticsError = assignedToError.message;
        return await enrichWorkItemsWithAssignedTo(fallback, { pat, org, project, iterationPath, areaPath });
      } catch (stateCategoryError) {
        try {
          const fallback = await queryIterationWorkItemsFromAnalytics({
            pat,
            org,
            project,
            team,
            iterationPath,
            areaPath,
            includeAssignedTo: false,
            includeStateCategory: false
          });
          fallback.warning = "Analytics WorkItems did not expose StateCategory, so SprintGen used state names for completion checks.";
          fallback.analyticsError = stateCategoryError.message;
          return await enrichWorkItemsWithAssignedTo(fallback, {
            pat,
            org,
            project,
            iterationPath,
            areaPath,
            missingWarning: "Analytics WorkItems did not expose AssignedTo, and WIQL could not fill contributor names for this sprint."
          });
        } catch (secondError) {
          const fallback = await queryCurrentSprintWorkItemsFromWiql({ pat, org, project, iterationPath, areaPath });
          fallback.warning = "Analytics WorkItems did not return cleanly, so SprintGen used a WIQL fallback scoped to the iteration.";
          fallback.analyticsError = secondError.message;
          return fallback;
        }
      }
    }
  }
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toDateKey(value) {
  return String(value || "").slice(0, 10);
}

function summarizeBurndownRows(rows) {
  const dailyTotals = new Map();
  const sortedRows = [...rows].sort((a, b) => String(a.DateValue).localeCompare(String(b.DateValue)));

  for (const row of sortedRows) {
    const dateKey = toDateKey(row.DateValue);
    const existing = dailyTotals.get(dateKey) || {
      date: dateKey,
      count: 0,
      totalStoryPoints: 0
    };

    existing.count += asNumber(row.Count);
    existing.totalStoryPoints += asNumber(row.TotalStoryPoints);
    dailyTotals.set(dateKey, existing);
  }

  const days = [...dailyTotals.values()].sort((a, b) => a.date.localeCompare(b.date));
  const maxStoryPoints = days.reduce((max, day) => Math.max(max, day.totalStoryPoints), 0);
  const latestDay = days[days.length - 1] || null;

  return {
    rowCount: rows.length,
    dayCount: days.length,
    maxStoryPoints,
    latestStoryPoints: latestDay ? latestDay.totalStoryPoints : 0,
    latestDate: latestDay ? latestDay.date : "",
    sampleRows: sortedRows.slice(0, 30)
  };
}

module.exports = {
  AdoError,
  fetchAnalyticsMetadata,
  getAdoConfig,
  listProjectTeams,
  listTeamAreaPaths,
  listTeamIterations,
  queryCurrentSprintWorkItems,
  queryIterationSnapshotRows,
  queryIterationWorkItems,
  queryStoryPointBurndown,
  resolveIterationInput,
  summarizeBurndownRows
};
