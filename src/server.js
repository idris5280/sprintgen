const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { generateReport, projectRoot, renderPresentationHtml } = require("./reportGenerator");

const app = express();
const port = process.env.PORT || 3000;
const runtimeDir = path.join(projectRoot, "runtime");
const jobsDir = path.join(runtimeDir, "jobs");
const sampleWorkbookPath = path.join(projectRoot, "input", "sample-sprint-demo.xlsx");
const maxUploadBytes = 8 * 1024 * 1024;
const maxJobAgeMs = 6 * 60 * 60 * 1000;

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
          <h1>Turn sprint wins into a polished demo report.</h1>
          <p class="lede">Upload the Excel workbook, celebrate what shipped, and generate a polished HTML preview plus a PDF for stakeholders.</p>
          ${errorHtml}
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
          <div class="spark-badge">MVP 1</div>
          <h2>Metric cards, not chart homework.</h2>
          <p>Bring Sprint Health, delivered work, business value, demo notes, and up-next plans. Velocity and burndown charts stay out of this MVP.</p>
          <ol class="steps">
            <li><span>1</span><strong>Fill workbook</strong><small>Basics, summary, metrics, delivered work, and up next.</small></li>
            <li><span>2</span><strong>Upload it</strong><small>The app validates required fields and reads your sprint story.</small></li>
            <li><span>3</span><strong>Share the win</strong><small>Preview HTML and download the stakeholder-ready PDF.</small></li>
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
        <p class="lede">Your sprint story is packaged into a polished HTML preview and a PDF download.</p>
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

function renderErrorPage(error) {
  return renderPage({
    title: "SprintGen - Workbook Needs Attention",
    bodyClass: "error-page",
    content: `
      <section class="result-card error-card">
        <div class="success-orb calm">fix</div>
        <div class="eyebrow">Workbook needs a tweak</div>
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
setInterval(cleanupOldJobs, 60 * 60 * 1000).unref();

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

app.use("/assets", express.static(path.join(projectRoot, "public"), { maxAge: 0 }));

app.get("/", (req, res) => {
  res.send(renderHomePage());
});

app.get("/template", (req, res) => {
  res.download(sampleWorkbookPath, "sample-sprint-demo.xlsx");
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
