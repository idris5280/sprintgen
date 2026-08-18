const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DevelopmentFileReviewStore } = require("../src/reviewStore");

test("development cloud substitute isolates owners and enforces ETags", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-store-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DevelopmentFileReviewStore(root);
  const review = { id: "00000000-0000-0000-0000-000000000001", ownerId: "user-a", creatorName: "A", source: "manual", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const first = await store.writeReview("user-a", review);
  assert.equal((await store.listReviews("user-a")).length, 1);
  assert.equal((await store.listReviews("user-b")).length, 0);
  await assert.rejects(() => store.readReview("user-b", review.id), /not found/i);
  await assert.rejects(() => store.writeReview("user-a", { ...review, updatedAt: new Date().toISOString() }, { etag: '"stale"' }), /another browser/i);
  const second = await store.writeReview("user-a", { ...review, status: "ready" }, { etag: first.etag });
  assert.equal(second.value.status, "ready");
  await assert.rejects(() => store.deleteReview("user-a", review.id, { etag: '"stale"' }), /another browser/i);
  await store.deleteReview("user-a", review.id, { etag: second.etag });
  assert.equal((await store.listReviews("user-a")).length, 0);
});

test("development store supports private nested media and settings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-media-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DevelopmentFileReviewStore(root);
  const id = "00000000-0000-0000-0000-000000000002";
  await store.writeReview("user-a", { id, ownerId: "user-a", source: "manual" });
  await store.writeArtifact("user-a", id, "media/00000000-0000-0000-0000-000000000003.png", Buffer.from("image"));
  const image = await store.readArtifact("user-a", id, "media/00000000-0000-0000-0000-000000000003.png");
  assert.equal(image.contentType, "image/png");
  await store.writeSettings("user-a", { meetingType: "daily-standup" });
  assert.equal((await store.readSettings("user-a")).value.meetingType, "daily-standup");
});
