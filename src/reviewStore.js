const fs = require("fs");
const path = require("path");
const { getAzureCredential } = require("./azureIdentity");
const { logEvent } = require("./logger");

function assertReviewId(reviewId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(reviewId || ""))) {
    const error = new Error("Invalid review id.");
    error.status = 400;
    error.code = "INVALID_REVIEW_ID";
    throw error;
  }
}

function safeUserSegment(userId) {
  const segment = String(userId || "").trim().replace(/[^a-z0-9._-]/gi, "_");

  if (!segment) {
    const error = new Error("An authenticated user is required.");
    error.status = 401;
    error.code = "AUTHENTICATION_REQUIRED";
    throw error;
  }

  return segment;
}

function reviewPrefix(userId, reviewId = "") {
  const owner = safeUserSegment(userId);

  if (reviewId) {
    assertReviewId(reviewId);
  }

  return `users/${owner}/reviews/${reviewId}`;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function storageMetadata(review) {
  return {
    owner: safeUserSegment(review.ownerId),
    creator: String(review.creatorName || "Scrum Studio user")
      .replace(/[^\x20-\x7E]/g, "_")
      .slice(0, 256),
    source: review.source === "ado" ? "ado" : "manual",
    created: String(review.createdAt || "").slice(0, 64),
    updated: String(review.updatedAt || "").slice(0, 64),
    schema: String(review.schemaVersion || 1)
  };
}

function decodeJson(value) {
  return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value || ""));
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

class BlobReviewStore {
  constructor({ accountUrl, containerName }) {
    let BlobServiceClient;

    try {
      ({ BlobServiceClient } = require("@azure/storage-blob"));
    } catch (error) {
      const dependencyError = new Error("Azure Blob Storage support is not installed. Run npm install before starting Scrum Studio.");
      dependencyError.code = "AZURE_STORAGE_NOT_INSTALLED";
      dependencyError.cause = error;
      throw dependencyError;
    }

    this.container = new BlobServiceClient(accountUrl, getAzureCredential()).getContainerClient(containerName);
  }

  async checkHealth() {
    await this.container.getProperties();
    return true;
  }

  async listReviews(userId) {
    // reviewPrefix(userId) already ends with "/" when no review id is given.
    const prefix = reviewPrefix(userId);
    const blobNames = [];

    for await (const item of this.container.listBlobsFlat({ prefix })) {
      if (item.name.endsWith("/review.json")) blobNames.push(item.name);
    }

    const reviews = await Promise.all(blobNames.map(async (name) => {
      try {
        const review = await this.readReview(userId, name.split("/").slice(-2, -1)[0]);
        return review.value;
      } catch (error) {
        // A single malformed review should not hide the rest of the user's library, but it must not vanish silently.
        logEvent("warn", "review_list_item_skipped", {
          blob: name,
          detail: String((error && error.message) || error).slice(0, 300)
        });
        return null;
      }
    }));

    return reviews
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  }

  async readReview(userId, reviewId) {
    const blob = this.container.getBlockBlobClient(`${reviewPrefix(userId, reviewId)}/review.json`);

    try {
      const response = await blob.download();
      return {
        value: decodeJson(await streamToBuffer(response.readableStreamBody)),
        etag: response.etag || ""
      };
    } catch (error) {
      if (error.statusCode === 404) {
        const notFound = new Error("That saved review was not found.");
        notFound.status = 404;
        notFound.code = "REVIEW_NOT_FOUND";
        throw notFound;
      }
      throw error;
    }
  }

  async writeReview(userId, review, { etag = "" } = {}) {
    assertReviewId(review.id);
    const blob = this.container.getBlockBlobClient(`${reviewPrefix(userId, review.id)}/review.json`);
    const payload = encodeJson(review);
    const response = await blob.uploadData(payload, {
      blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
      metadata: storageMetadata(review),
      conditions: etag ? { ifMatch: etag } : undefined
    });

    return { value: review, etag: response.etag || "" };
  }

  async deleteReview(userId, reviewId, { etag = "" } = {}) {
    if (etag) {
      const current = await this.readReview(userId, reviewId);
      if (current.etag !== etag) {
        const conflict = new Error("This review changed in another browser window. Reload before deleting it.");
        conflict.status = 412;
        conflict.code = "ETAG_MISMATCH";
        throw conflict;
      }
    }
    const prefix = `${reviewPrefix(userId, reviewId)}/`;

    for await (const item of this.container.listBlobsFlat({ prefix })) {
      const blob = this.container.getBlockBlobClient(item.name);
      await blob.deleteIfExists();
    }
  }

  async writeArtifact(userId, reviewId, name, content, contentType) {
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(String(name || "")) || String(name).includes("..")) {
      const error = new Error("Invalid artifact name.");
      error.status = 400;
      throw error;
    }
    const blob = this.container.getBlockBlobClient(`${reviewPrefix(userId, reviewId)}/${name}`);
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ""), "utf8");
    await blob.uploadData(payload, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  async readArtifact(userId, reviewId, name) {
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(String(name || "")) || String(name).includes("..")) {
      const error = new Error("Invalid artifact name.");
      error.status = 400;
      throw error;
    }
    const blob = this.container.getBlockBlobClient(`${reviewPrefix(userId, reviewId)}/${name}`);
    const response = await blob.download();
    return {
      body: await streamToBuffer(response.readableStreamBody),
      contentType: response.contentType || "application/octet-stream"
    };
  }

  async readSettings(userId) {
    const blob = this.container.getBlockBlobClient(`users/${safeUserSegment(userId)}/settings/lobby.json`);
    try {
      const response = await blob.download();
      return { value: decodeJson(await streamToBuffer(response.readableStreamBody)), etag: response.etag || "" };
    } catch (error) {
      if (error.statusCode === 404) return { value: null, etag: "" };
      throw error;
    }
  }

  async writeSettings(userId, value, { etag = "" } = {}) {
    const blob = this.container.getBlockBlobClient(`users/${safeUserSegment(userId)}/settings/lobby.json`);
    const response = await blob.uploadData(encodeJson(value), {
      blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
      conditions: etag ? { ifMatch: etag } : undefined
    });
    return { value, etag: response.etag || "" };
  }
}

class DevelopmentFileReviewStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  userRoot(userId) {
    return path.join(this.rootDir, safeUserSegment(userId));
  }

  reviewRoot(userId, reviewId) {
    assertReviewId(reviewId);
    return path.join(this.userRoot(userId), "reviews", reviewId);
  }

  async checkHealth() {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.accessSync(this.rootDir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  }

  async listReviews(userId) {
    const root = path.join(this.userRoot(userId), "reviews");
    if (!fs.existsSync(root)) return [];

    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return decodeJson(fs.readFileSync(path.join(root, entry.name, "review.json")));
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  }

  async readReview(userId, reviewId) {
    const file = path.join(this.reviewRoot(userId, reviewId), "review.json");
    if (!fs.existsSync(file)) {
      const error = new Error("That saved review was not found.");
      error.status = 404;
      error.code = "REVIEW_NOT_FOUND";
      throw error;
    }
    const stats = fs.statSync(file);
    return { value: decodeJson(fs.readFileSync(file)), etag: `\"${stats.mtimeMs}\"` };
  }

  async writeReview(userId, review, { etag = "" } = {}) {
    const root = this.reviewRoot(userId, review.id);
    fs.mkdirSync(root, { recursive: true });
    if (etag) {
      const current = await this.readReview(userId, review.id).catch(() => null);
      if (!current || current.etag !== etag) {
        const error = new Error("This review changed in another browser window. Reload before saving again.");
        error.status = 412;
        error.code = "ETAG_MISMATCH";
        throw error;
      }
    }
    fs.writeFileSync(path.join(root, "review.json"), encodeJson(review));
    return this.readReview(userId, review.id);
  }

  async deleteReview(userId, reviewId, { etag = "" } = {}) {
    if (etag) {
      const current = await this.readReview(userId, reviewId);
      if (current.etag !== etag) {
        const conflict = new Error("This review changed in another browser window. Reload before deleting it.");
        conflict.status = 412;
        conflict.code = "ETAG_MISMATCH";
        throw conflict;
      }
    }
    fs.rmSync(this.reviewRoot(userId, reviewId), { recursive: true, force: true });
  }

  async writeArtifact(userId, reviewId, name, content) {
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(String(name || "")) || String(name).includes("..")) {
      const error = new Error("Invalid artifact name.");
      error.status = 400;
      throw error;
    }
    const file = path.join(this.reviewRoot(userId, reviewId), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  async readArtifact(userId, reviewId, name) {
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(String(name || "")) || String(name).includes("..")) {
      const error = new Error("Invalid artifact name.");
      error.status = 400;
      throw error;
    }
    const file = path.join(this.reviewRoot(userId, reviewId), name);
    if (!fs.existsSync(file)) {
      const error = new Error("That artifact was not found.");
      error.status = 404;
      throw error;
    }
    const extension = path.extname(name).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif"
    };
    return { body: fs.readFileSync(file), contentType: contentTypes[extension] || "application/octet-stream" };
  }

  async readSettings(userId) {
    const file = path.join(this.userRoot(userId), "settings", "lobby.json");
    if (!fs.existsSync(file)) return { value: null, etag: "" };
    return { value: decodeJson(fs.readFileSync(file)), etag: `\"${fs.statSync(file).mtimeMs}\"` };
  }

  async writeSettings(userId, value) {
    const file = path.join(this.userRoot(userId), "settings", "lobby.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodeJson(value));
    return this.readSettings(userId);
  }
}

function createReviewStore({ projectRoot }) {
  const accountUrl = String(process.env.AZURE_STORAGE_ACCOUNT_URL || "").trim();
  const containerName = String(process.env.AZURE_STORAGE_CONTAINER || "").trim();

  if (accountUrl && containerName) {
    return new BlobReviewStore({ accountUrl, containerName });
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("AZURE_STORAGE_ACCOUNT_URL and AZURE_STORAGE_CONTAINER are required in production.");
  }

  const root = process.env.SCRUM_STUDIO_DEV_DATA_DIR
    ? path.resolve(process.env.SCRUM_STUDIO_DEV_DATA_DIR)
    : path.join(projectRoot, "runtime", "cloud-dev");
  return new DevelopmentFileReviewStore(root);
}

module.exports = {
  BlobReviewStore,
  DevelopmentFileReviewStore,
  createReviewStore,
  reviewPrefix,
  safeUserSegment
};
