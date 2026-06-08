const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");
const { chromium } = require("playwright");
const { readWorkbook } = require("./readWorkbook");
const { registerHelpers } = require("./templateHelpers");

const projectRoot = path.resolve(__dirname, "..");
const templatePath = path.join(projectRoot, "templates", "sprint-demo.hbs");
const presentationTemplatePath = path.join(projectRoot, "templates", "sprint-demo-present.hbs");
const validPresentationVibes = new Set(["light", "dark", "prismatic"]);

function normalizePresentationVibe(vibe) {
  return validPresentationVibes.has(vibe) ? vibe : "prismatic";
}

function toFileUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, "/")}`;
}

function renderHtml(workbookPath) {
  registerHelpers(Handlebars);

  const templateSource = fs.readFileSync(templatePath, "utf8");
  const template = Handlebars.compile(templateSource);
  const data = readWorkbook(workbookPath);
  const html = template({
    ...data,
    generatedAt: new Date().toISOString().slice(0, 10)
  });

  return { data, html };
}

function renderPresentationHtml(workbookPath, vibe) {
  registerHelpers(Handlebars);

  const presentationVibe = normalizePresentationVibe(vibe);
  const templateSource = fs.readFileSync(presentationTemplatePath, "utf8");
  const template = Handlebars.compile(templateSource);
  const data = readWorkbook(workbookPath);
  const html = template({
    ...data,
    vibe: presentationVibe,
    generatedAt: new Date().toISOString().slice(0, 10)
  });

  return { data, html, vibe: presentationVibe };
}

async function exportPdf(htmlPath, pdfPath) {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
    await page.goto(toFileUrl(htmlPath), { waitUntil: "networkidle" });
    await page.pdf({
      path: pdfPath,
      format: "Letter",
      printBackground: true,
      margin: {
        top: "0.35in",
        right: "0.35in",
        bottom: "0.35in",
        left: "0.35in"
      }
    });
  } finally {
    await browser.close();
  }
}

async function generateReport({ workbookPath, htmlOutputPath, pdfOutputPath }) {
  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Workbook not found: ${workbookPath}`);
  }

  const { data, html } = renderHtml(workbookPath);

  fs.mkdirSync(path.dirname(htmlOutputPath), { recursive: true });
  fs.mkdirSync(path.dirname(pdfOutputPath), { recursive: true });
  fs.writeFileSync(htmlOutputPath, html, "utf8");
  await exportPdf(htmlOutputPath, pdfOutputPath);

  return {
    data,
    htmlOutputPath,
    pdfOutputPath
  };
}

module.exports = {
  exportPdf,
  generateReport,
  normalizePresentationVibe,
  projectRoot,
  renderHtml,
  renderPresentationHtml
};
