const COMPLETED_STATES = new Set(["closed", "done", "completed"]);
const STORY_TYPES = new Set(["user story"]);
const ITEM_TYPES = new Set(["user story", "bug"]);

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateKey(value) {
  return String(value || "").slice(0, 10);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function getField(item, fieldName, analyticsName) {
  const fields = item && item.fields ? item.fields : item || {};
  return fields[fieldName] ?? fields[analyticsName] ?? item[analyticsName] ?? "";
}

function normalizeIdentity(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "object") {
    return value.displayName || value.uniqueName || value.name || value.mailAddress || "";
  }

  return String(value).replace(/\s*<[^>]+>\s*$/, "").trim();
}

function normalizeIdentityList(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(normalizeIdentity).filter(Boolean);
  }

  if (typeof value === "object") {
    return [normalizeIdentity(value)].filter(Boolean);
  }

  return String(value)
    .split(";")
    .map(normalizeIdentity)
    .filter(Boolean);
}

function getTestedByField(item) {
  const fields = item && item.fields ? item.fields : item || {};

  return (
    fields.TestedBy ||
    fields.testedBy ||
    fields["Custom.TestedBy"] ||
    fields["Microsoft.VSTS.Common.TestedBy"] ||
    fields["Microsoft.VSTS.CMMI.TestedBy"] ||
    Object.entries(fields).find(([key, value]) => normalize(key).replace(/[^a-z0-9]+/g, "").endsWith("testedby") && value)?.[1] ||
    ""
  );
}

function cleanContributorDisplayName(value) {
  const cleaned = normalizeIdentity(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/_/g, " ")
    .replace(/\bX\s*-\s*/gi, "")
    .replace(/^\s*X+\s+/i, "")
    .replace(/\s+X+\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.-])/g, "$1")
    .replace(/^[,.-]\s*|\s*[,.-]$/g, "")
    .trim();

  return cleaned;
}

function normalizeWorkItem(item) {
  const storyPoints = getField(item, "Microsoft.VSTS.Scheduling.StoryPoints", "StoryPoints");
  const assignedTo = getField(item, "System.AssignedTo", "AssignedTo");
  const testedBy = getTestedByField(item);

  return {
    id: getField(item, "System.Id", "WorkItemId") || item.id || "",
    title: getField(item, "System.Title", "Title") || "Untitled work item",
    state: getField(item, "System.State", "State") || "Unknown",
    stateCategory: getField(item, "System.StateCategory", "StateCategory") || "",
    type: getField(item, "System.WorkItemType", "WorkItemType") || "Work Item",
    storyPoints: storyPoints === null || storyPoints === undefined || storyPoints === "" ? null : asNumber(storyPoints),
    assignedTo: normalizeIdentity(assignedTo),
    createdDate: getField(item, "System.CreatedDate", "CreatedDate") || "",
    changedDate: getField(item, "System.ChangedDate", "ChangedDate") || "",
    tags: getField(item, "System.Tags", "Tags") || "",
    testedBy: normalizeIdentityList(testedBy)
  };
}

function isCompletedState(state, stateCategory) {
  if (normalize(stateCategory) === "completed") {
    return true;
  }

  return COMPLETED_STATES.has(normalize(state));
}

function isStory(item) {
  return STORY_TYPES.has(normalize(item.type));
}

function isMetricItem(item) {
  return ITEM_TYPES.has(normalize(item.type));
}

function hasEstimate(item) {
  return item.storyPoints !== null && item.storyPoints > 0;
}

function sortIterations(iterations) {
  return [...iterations].sort((a, b) => {
    const aFinish = toDate(a.attributes && a.attributes.finishDate) || toDate(a.finishDate) || new Date(0);
    const bFinish = toDate(b.attributes && b.attributes.finishDate) || toDate(b.finishDate) || new Date(0);
    return aFinish.getTime() - bFinish.getTime();
  });
}

function iterationPath(iteration) {
  return iteration.path || iteration.iterationPath || "";
}

function iterationFinishDate(iteration) {
  return (iteration.attributes && iteration.attributes.finishDate) || iteration.finishDate || "";
}

function iterationStartDate(iteration) {
  return (iteration.attributes && iteration.attributes.startDate) || iteration.startDate || "";
}

function findPreviousIteration(iterations, selectedIteration) {
  const selectedStart = toDate(selectedIteration.startDate || iterationStartDate(selectedIteration));
  const selectedPath = selectedIteration.path || iterationPath(selectedIteration);

  const candidates = sortIterations(iterations).filter((iteration) => {
    const finish = toDate(iterationFinishDate(iteration));
    return iterationPath(iteration) !== selectedPath && finish && selectedStart && finish < selectedStart;
  });

  return candidates[candidates.length - 1] || null;
}

function findVelocityIterations(iterations, selectedIteration, count = 3) {
  const selectedStart = toDate(selectedIteration.startDate || iterationStartDate(selectedIteration));
  const selectedPath = selectedIteration.path || iterationPath(selectedIteration);

  return sortIterations(iterations)
    .filter((iteration) => {
      const finish = toDate(iterationFinishDate(iteration));
      return iterationPath(iteration) !== selectedPath && finish && selectedStart && finish < selectedStart;
    })
    .slice(-count);
}

function findNextIteration(iterations, selectedIteration) {
  const selectedFinish = toDate(selectedIteration.finishDate || iterationFinishDate(selectedIteration));
  const selectedPath = selectedIteration.path || iterationPath(selectedIteration);

  const candidates = sortIterations(iterations).filter((iteration) => {
    const start = toDate(iterationStartDate(iteration));
    return iterationPath(iteration) !== selectedPath && start && selectedFinish && start >= selectedFinish;
  });

  return candidates[0] || null;
}

function summarizeWorkItems(rawItems) {
  const items = rawItems.map(normalizeWorkItem);
  const stories = items.filter(isStory);
  const metricItems = items.filter(isMetricItem);
  const completedItems = metricItems.filter((item) => isCompletedState(item.state, item.stateCategory));
  const completedStories = stories.filter((item) => isCompletedState(item.state, item.stateCategory));
  const carryoverStories = stories.filter((item) => !isCompletedState(item.state, item.stateCategory));
  const unestimatedStories = stories.filter((item) => !hasEstimate(item));
  const deliveredStoryPoints = completedStories.reduce((sum, item) => sum + asNumber(item.storyPoints), 0);
  const committedStoryPoints = stories.reduce((sum, item) => sum + asNumber(item.storyPoints), 0);
  const carryoverStoryPoints = carryoverStories.reduce((sum, item) => sum + asNumber(item.storyPoints), 0);

  return {
    items,
    stories,
    metricItems,
    completedItems,
    completedStories,
    carryoverStories,
    unestimatedStories,
    deliveredStoryPoints,
    committedStoryPoints,
    carryoverStoryPoints
  };
}

function buildBurndownSeries(rows) {
  const daily = new Map();
  const sortedRows = [...rows].sort((a, b) => String(a.DateValue).localeCompare(String(b.DateValue)));

  for (const row of sortedRows) {
    const date = toDateKey(row.DateValue);
    const existing = daily.get(date) || {
      date,
      remainingItems: 0,
      remainingStoryPoints: 0,
      totalItems: 0,
      totalStoryPoints: 0
    };
    const count = asNumber(row.Count);
    const storyPoints = asNumber(row.TotalStoryPoints);

    existing.totalItems += count;
    existing.totalStoryPoints += storyPoints;

    if (!isCompletedState(row.State, row.StateCategory)) {
      existing.remainingItems += count;
      existing.remainingStoryPoints += storyPoints;
    }

    daily.set(date, existing);
  }

  const series = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const first = series[0] || null;
  const latest = series[series.length - 1] || null;

  return {
    rowCount: rows.length,
    dayCount: series.length,
    series,
    startStoryPoints: first ? first.remainingStoryPoints : 0,
    latestStoryPoints: latest ? latest.remainingStoryPoints : 0,
    latestDate: latest ? latest.date : "",
    totalStoryPoints: first ? first.totalStoryPoints : 0,
    sampleRows: sortedRows.slice(0, 30)
  };
}

function buildVelocitySummary(velocityInputs) {
  const sprints = velocityInputs.map(({ iteration, items }) => {
    const summary = summarizeWorkItems(items);

    return {
      name: iteration.name || "",
      path: iteration.path || "",
      finishDate: iterationFinishDate(iteration),
      completedItems: summary.completedItems.length,
      completedStoryPoints: summary.deliveredStoryPoints,
      committedStoryPoints: summary.committedStoryPoints
    };
  });
  const totalCompletedPoints = sprints.reduce((sum, sprint) => sum + sprint.completedStoryPoints, 0);

  return {
    sprints,
    averageCompletedPoints: sprints.length > 0 ? totalCompletedPoints / sprints.length : 0,
    sprintCount: sprints.length
  };
}

function summarizeContributors(items) {
  const contributors = new Map();

  for (const item of items || []) {
    const names = [item.assignedTo, ...(item.testedBy || [])];

    for (const name of names) {
      const displayName = cleanContributorDisplayName(name);
      const key = normalize(displayName);

      if (key && !contributors.has(key)) {
        contributors.set(key, displayName);
      }
    }
  }

  return [...contributors.values()].sort((a, b) => a.localeCompare(b));
}

function buildAdoMetrics({ selectedIteration, selectedRows, selectedItems, previousIteration, previousRows, velocityInputs }) {
  const itemSummary = summarizeWorkItems(selectedItems);
  const selectedBurndown = buildBurndownSeries(selectedRows);
  const previousBurndown = previousRows ? buildBurndownSeries(previousRows) : null;
  const velocity = buildVelocitySummary(velocityInputs);
  const completionRate =
    itemSummary.committedStoryPoints > 0
      ? (itemSummary.deliveredStoryPoints / itemSummary.committedStoryPoints) * 100
      : 0;

  return {
    sprintHealthCards: [
      {
        label: "Completed Items",
        value: itemSummary.completedItems.length,
        tone: "green",
        detail: `${itemSummary.deliveredStoryPoints} story pts delivered`
      },
      {
        label: "Delivered Points",
        value: itemSummary.deliveredStoryPoints,
        tone: "blue",
        detail: "Completed User Story points"
      },
      {
        label: "Completion Rate",
        value: `${Math.round(completionRate)}%`,
        tone: completionRate >= 90 ? "green" : completionRate >= 70 ? "blue" : "orange",
        detail: "Delivered points / committed points"
      }
    ],
    velocity,
    contributors: summarizeContributors(itemSummary.items),
    selectedBurndown,
    previousBurndown,
    previousIteration,
    items: {
      completed: itemSummary.completedItems,
      unestimated: itemSummary.unestimatedStories,
      carryover: itemSummary.carryoverStories
    },
    totals: {
      committedStoryPoints: itemSummary.committedStoryPoints,
      deliveredStoryPoints: itemSummary.deliveredStoryPoints,
      carryoverStoryPoints: itemSummary.carryoverStoryPoints,
      completedItems: itemSummary.completedItems.length,
      totalStories: itemSummary.stories.length,
      unestimatedStories: itemSummary.unestimatedStories.length,
      carryoverStories: itemSummary.carryoverStories.length,
      completionRate
    }
  };
}

module.exports = {
  buildAdoMetrics,
  buildBurndownSeries,
  findNextIteration,
  findPreviousIteration,
  findVelocityIterations,
  isCompletedState,
  normalizeWorkItem,
  summarizeWorkItems
};
