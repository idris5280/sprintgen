const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../src/server");

function identityHeaders(userId, name = "QA Scrum Master") {
  return {
    "Content-Type": "application/json",
    "x-ms-client-principal-id": userId,
    "x-ms-client-principal-name": name
  };
}

test("cloud API supports an owner-scoped manual review journey", async (t) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const ownerHeaders = identityHeaders("integration-owner");

  const live = await fetch(`${base}/health/live`);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).status, "live");
  assert.match(live.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.equal(live.headers.get("x-content-type-options"), "nosniff");

  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).storage, "ready");

  const me = await fetch(`${base}/api/me`, { headers: ownerHeaders });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get("cache-control"), "private, no-store");
  assert.equal((await me.json()).user.id, "integration-owner");

  const create = await fetch(`${base}/api/reviews`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ identity: { team: "Platform", sprint: "Sprint Spotlight" } })
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  const reviewId = created.review.id;
  assert.equal(created.review.ownerId, "integration-owner");
  assert.equal(created.review.source, "manual");

  const forbiddenByOwnership = await fetch(`${base}/api/reviews/${reviewId}`, {
    headers: identityHeaders("different-user")
  });
  assert.equal(forbiddenByOwnership.status, 404);

  const mediaForm = new FormData();
  mediaForm.append("file", new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")], { type: "image/png" }), "team.png");
  const mediaUpload = await fetch(`${base}/api/reviews/${reviewId}/media`, {
    method: "POST",
    headers: { "x-ms-client-principal-id": "integration-owner", "x-ms-client-principal-name": "QA Scrum Master" },
    body: mediaForm
  });
  assert.equal(mediaUpload.status, 201);
  const media = await mediaUpload.json();

  const missingVersion = await fetch(`${base}/api/reviews/${reviewId}`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ identity: {}, narrative: created.review.narrative })
  });
  assert.equal(missingVersion.status, 428);

  const update = await fetch(`${base}/api/reviews/${reviewId}`, {
    method: "PUT",
    headers: { ...ownerHeaders, "If-Match": created.etag },
    body: JSON.stringify({
      identity: { team: "Platform", sprint: "Sprint 42", startDate: "", finishDate: "" },
      narrative: {
        ...created.review.narrative,
        teamLogo: { imageName: "team.png", mediaRef: media.mediaRef },
        sections: [
          { id: "delivery-1", type: "delivery", title: "Delivered", bodyText: "A stakeholder-ready update.", businessValue: "Clearer decisions.", stories: [] },
          { id: "challenge-1", type: "challenge", title: "Challenge", bodyText: "A constraint was resolved.", businessValue: "Delivery stays predictable." },
          { id: "risk-1", type: "risk", title: "Risk", description: "Timeline pressure", impact: "high", likelihood: "medium", roam: "owned" },
          { id: "next-1", type: "next_steps", title: "Next", bodyText: "Prepare the next increment.", stories: [] },
          { id: "demo-1", type: "live_demo", title: "Demo", presenters: ["QA Scrum Master"], note: "Show the new workflow." }
        ]
      }
    })
  });
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.review.sprintName, "Sprint 42");

  const invalidColor = await fetch(`${base}/api/reviews/${reviewId}/presentation`, {
    method: "PUT",
    headers: { ...ownerHeaders, "If-Match": updated.etag },
    body: JSON.stringify({ color: "CE1141" })
  });
  assert.equal(invalidColor.status, 400);

  const colorUpdate = await fetch(`${base}/api/reviews/${reviewId}/presentation`, {
    method: "PUT",
    headers: { ...ownerHeaders, "If-Match": updated.etag },
    body: JSON.stringify({ color: "#CE1141" })
  });
  assert.equal(colorUpdate.status, 200);
  const colorRecord = await colorUpdate.json();
  assert.equal(colorRecord.review.presentation.color, "#CE1141");

  const staleColorUpdate = await fetch(`${base}/api/reviews/${reviewId}/presentation`, {
    method: "PUT",
    headers: { ...ownerHeaders, "If-Match": updated.etag },
    body: JSON.stringify({ color: "#FF69B4" })
  });
  assert.equal(staleColorUpdate.status, 412);

  const generate = await fetch(`${base}/api/reviews/${reviewId}/generate`, {
    method: "POST",
    headers: { ...ownerHeaders, "If-Match": colorRecord.etag }
  });
  assert.equal(generate.status, 200, generate.status === 200 ? undefined : await generate.text());
  const generated = await generate.json();
  assert.equal(generated.links.color, `/reviews/${reviewId}/present?vibe=color&color=CE1141`);
  assert.equal(generated.links.floatingLines, `/reviews/${reviewId}/present?vibe=floating-lines`);
  assert.equal(generated.links.iridescence, `/reviews/${reviewId}/present?vibe=iridescence`);

  const standaloneHtml = await fetch(`${base}/reviews/${reviewId}/download-html`, { headers: ownerHeaders });
  assert.equal(standaloneHtml.status, 200);
  const standaloneHtmlText = await standaloneHtml.text();
  assert.match(standaloneHtmlText, /data:image\/png;base64,/);
  assert.doesNotMatch(standaloneHtmlText, /spotlight-present|iridescence-present|reveal\.js/);

  const presentation = await fetch(`${base}/reviews/${reviewId}/present?vibe=blue`, { headers: ownerHeaders });
  assert.equal(presentation.status, 200);
  const presentationText = await presentation.text();
  assert.match(presentationText, /Sprint 42/);
  assert.match(presentationText, /data-fullscreen/);

  const savedColorPresentation = await fetch(`${base}/reviews/${reviewId}/present?vibe=color`, { headers: ownerHeaders });
  assert.equal(savedColorPresentation.status, 200);
  const savedColorText = await savedColorPresentation.text();
  assert.match(savedColorText, /class="vibe-color"/);
  assert.match(savedColorText, /--deck-color:#CE1141/);

  const overrideColorPresentation = await fetch(`${base}/reviews/${reviewId}/present?vibe=color&color=FF69B4`, { headers: ownerHeaders });
  assert.equal(overrideColorPresentation.status, 200);
  assert.match(await overrideColorPresentation.text(), /--deck-color:#FF69B4/);

  const invalidOverridePresentation = await fetch(`${base}/reviews/${reviewId}/present?vibe=color&color=wrong`, { headers: ownerHeaders });
  assert.equal(invalidOverridePresentation.status, 200);
  assert.match(await invalidOverridePresentation.text(), /--deck-color:#CE1141/);

  const legacyLightPresentation = await fetch(`${base}/reviews/${reviewId}/present?vibe=light`, { headers: ownerHeaders });
  assert.equal(legacyLightPresentation.status, 200);
  assert.match(await legacyLightPresentation.text(), /class="vibe-color"/);

  const floatingLines = await fetch(`${base}/reviews/${reviewId}/present?vibe=floating-lines#slide-2`, { headers: ownerHeaders });
  assert.equal(floatingLines.status, 200);
  assert.match(floatingLines.headers.get("cache-control") || "", /private, no-store/);
  const floatingLinesText = await floatingLines.text();
  assert.match(floatingLinesText, /Sprint 42/);
  assert.match(floatingLinesText, /class="floating-lines-document"/);
  assert.match(floatingLinesText, /class="reveal"/);
  assert.match(floatingLinesText, /class="floating-lines-background" data-floating-lines/);
  assert.match(floatingLinesText, /spotlight-present\.css\?v=8/);
  assert.match(floatingLinesText, /spotlight-present\.js\?v=12/);
  assert.match(floatingLinesText, /reveal\.js\?v=6\.0\.0/);
  assert.match(floatingLinesText, /data-fullscreen/);
  assert.match(floatingLinesText, /data-fullscreen-icon[\s\S]*data-maximize-path/);
  assert.doesNotMatch(floatingLinesText, /data-enter-icon|data-exit-icon/);

  const legacySpotlight = await fetch(`${base}/reviews/${reviewId}/present?vibe=spotlight`, { headers: ownerHeaders });
  assert.equal(legacySpotlight.status, 200);
  assert.match(await legacySpotlight.text(), /Floating Lines Mode/);

  const iridescence = await fetch(`${base}/reviews/${reviewId}/present?vibe=iridescence`, { headers: ownerHeaders });
  assert.equal(iridescence.status, 200);
  assert.match(iridescence.headers.get("cache-control") || "", /private, no-store/);
  const iridescenceText = await iridescence.text();
  assert.match(iridescenceText, /Sprint 42/);
  assert.match(iridescenceText, /class="spotlight-document iridescence-document"/);
  assert.match(iridescenceText, /class="iridescence-background" data-iridescence/);
  assert.match(iridescenceText, /iridescence-present\.css\?v=2/);
  assert.doesNotMatch(iridescenceText, /iridescence-scrim/);
  assert.match(iridescenceText, /spotlight-present\.js\?v=12/);
  assert.match(iridescenceText, /reveal\.js\?v=6\.0\.0/);
  assert.match(iridescenceText, /data-fullscreen/);

  const forbiddenFloatingLines = await fetch(`${base}/reviews/${reviewId}/present?vibe=floating-lines`, {
    headers: identityHeaders("different-user")
  });
  assert.equal(forbiddenFloatingLines.status, 404);

  const revealAsset = await fetch(`${base}/assets/vendor/reveal/reveal.js`);
  assert.equal(revealAsset.status, 200);
  assert.match(revealAsset.headers.get("cache-control") || "", /immutable/);
  assert.equal((await fetch(`${base}/assets/vendor/reveal/LICENSE`)).status, 404);

  for (const vibe of ["light", "blue", "prismatic"]) {
    const classicPresentation = await fetch(`${base}/reviews/${reviewId}/present?vibe=${vibe}`, { headers: ownerHeaders });
    assert.equal(classicPresentation.status, 200);
    assert.match(await classicPresentation.text(), /data-fullscreen/);
  }

  const legacyPresentationLink = await fetch(`${base}/ado-present/${reviewId}?vibe=blue`, { headers: ownerHeaders });
  assert.equal(legacyPresentationLink.status, 200);
  assert.match(await legacyPresentationLink.text(), /Sprint 42/);

  const latestRecordResponse = await fetch(`${base}/api/reviews/${reviewId}`, { headers: ownerHeaders });
  assert.equal(latestRecordResponse.status, 200);
  const latestRecord = await latestRecordResponse.json();
  const remove = await fetch(`${base}/api/reviews/${reviewId}`, {
    method: "DELETE",
    headers: { ...ownerHeaders, "If-Match": latestRecord.etag }
  });
  assert.equal(remove.status, 204, remove.status === 204 ? undefined : await remove.text());
});
