const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");
const { chromium } = require("playwright");
const { renderBrandRail } = require("./brandRail");
const { readWorkbook } = require("./readWorkbook");
const { registerHelpers } = require("./templateHelpers");

const projectRoot = path.resolve(__dirname, "..");
const templatePath = path.join(projectRoot, "templates", "sprint-demo.hbs");
const presentationTemplatePath = path.join(projectRoot, "templates", "sprint-demo-present.hbs");
const DEFAULT_PRESENTATION_COLOR = "#0076C0";
const validPresentationVibes = new Set(["color", "dark", "prismatic", "floating-lines", "iridescence"]);

function canonicalPresentationColor(value) {
  const match = /^#?([a-f\d]{6})$/i.exec(String(value || "").trim());
  return match ? `#${match[1].toUpperCase()}` : "";
}

function isValidPresentationColor(value) {
  return /^#[a-f\d]{6}$/i.test(String(value || "").trim());
}

function normalizePresentationColor(value, fallback = DEFAULT_PRESENTATION_COLOR) {
  return canonicalPresentationColor(value) || canonicalPresentationColor(fallback) || DEFAULT_PRESENTATION_COLOR;
}

function relativeLuminance(hexColor) {
  const rgb = normalizePresentationColor(hexColor)
    .slice(1)
    .match(/.{2}/g)
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return (0.2126 * rgb[0]) + (0.7152 * rgb[1]) + (0.0722 * rgb[2]);
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function buildPresentationColorTokens(value) {
  const color = normalizePresentationColor(value);
  const darkText = "#000000";
  const lightText = "#FFFFFF";
  const onColor = contrastRatio(darkText, color) >= contrastRatio(lightText, color) ? darkText : lightText;
  return {
    color,
    onColor,
    surfaceMix: onColor === lightText ? "#000000" : "#FFFFFF"
  };
}

function normalizePresentationVibe(vibe) {
  const normalized = String(vibe || "").trim().toLowerCase();

  if (normalized === "blue") {
    return "dark";
  }

  if (normalized === "light") {
    return "color";
  }

  if (normalized === "spotlight" || normalized === "floatinglines") {
    return "floating-lines";
  }

  return validPresentationVibes.has(normalized) ? normalized : "prismatic";
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
    brandRailHtml: renderBrandRail({
      className: "brand-rail report-brand-rail"
    }),
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
    presentationBrandRailTop: renderBrandRail({
      mono: true,
      className: "presentation-brand-rail is-top"
    }),
    presentationBrandRailBottom: renderBrandRail({
      mono: true,
      className: "presentation-brand-rail is-bottom"
    }),
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
  DEFAULT_PRESENTATION_COLOR,
  buildPresentationColorTokens,
  canonicalPresentationColor,
  exportPdf,
  generateReport,
  isValidPresentationColor,
  normalizePresentationColor,
  normalizePresentationVibe,
  projectRoot,
  renderHtml,
  renderPresentationHtml
};
