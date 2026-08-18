const test = require("node:test");
const assert = require("node:assert/strict");
const { createArtifactEngine } = require("../src/artifactEngine");

test("artifact engine accepts a framework-neutral versioned snapshot", async () => {
  const calls = [];
  const engine = createArtifactEngine({
    htmlRenderer(snapshot) { calls.push(["html", snapshot.schemaVersion]); return "<html>report</html>"; },
    presentationRenderer(snapshot, theme) { calls.push(["presentation", snapshot.schemaVersion, theme]); return "<html>deck</html>"; },
    pdfGenerator(html, pdf) { calls.push(["pdf", html, pdf]); return Promise.resolve(); }
  });
  const snapshot = { id: "00000000-0000-0000-0000-000000000001", narrative: {} };
  assert.equal(engine.renderHtmlReport(snapshot), "<html>report</html>");
  assert.equal(engine.renderPresentation(snapshot, "blue"), "<html>deck</html>");
  await engine.generatePdf("report.html", "report.pdf");
  assert.deepEqual(calls, [["html", 1], ["presentation", 1, "blue"], ["pdf", "report.html", "report.pdf"]]);
});

test("artifact engine rejects non-review application state", () => {
  const engine = createArtifactEngine({ htmlRenderer() {}, presentationRenderer() {}, pdfGenerator() {} });
  assert.throws(() => engine.renderHtmlReport({}), /versioned review snapshot/i);
});
