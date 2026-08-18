const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeStoryItems } = require("../src/server");

test("ADO Analytics work items normalize to the Fluent story contract", () => {
  const items = normalizeStoryItems([{
    WorkItemId: 102553,
    Title: "Prepare the release",
    WorkItemType: "User Story",
    State: "Closed",
    StateCategory: "Completed",
    StoryPoints: 5,
    AreaPath: "Project\\Value Area\\Team"
  }]);

  assert.deepEqual(items.map(({ id, title, type, state, stateCategory, storyPoints, areaPath }) => ({ id, title, type, state, stateCategory, storyPoints, areaPath })), [{
    id: 102553,
    title: "Prepare the release",
    type: "User Story",
    state: "Closed",
    stateCategory: "Completed",
    storyPoints: 5,
    areaPath: "Project\\Value Area\\Team"
  }]);
});
