const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const logoPath = path.join(projectRoot, "public", "eep-logo-vector.svg");

let cachedSvg = null;

function cleanSvg(svg) {
  return String(svg || "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<sodipodi:namedview[\s\S]*?<\/sodipodi:namedview>/g, "")
    .replace(/\sxmlns:(?:inkscape|sodipodi|svg)="[^"]*"/g, "")
    .replace(/\s(?:inkscape|sodipodi|svg):[A-Za-z0-9-]+="[^"]*"/g, "")
    .replace(/\sid="[^"]*"/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function loadBrandSvg() {
  if (cachedSvg !== null) {
    return cachedSvg;
  }

  if (!fs.existsSync(logoPath)) {
    cachedSvg = "";
    return cachedSvg;
  }

  cachedSvg = cleanSvg(fs.readFileSync(logoPath, "utf8"));
  return cachedSvg;
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toMonochrome(svg) {
  return svg
    .replace(/fill:\s*#[0-9a-fA-F]{3,6}/g, "fill:currentColor")
    .replace(/stroke:\s*#[0-9a-fA-F]{3,6}/g, "stroke:currentColor");
}

function renderInlineLogo({ mono = false, logoClass = "brand-rail-logo" } = {}) {
  const source = loadBrandSvg();

  if (!source) {
    return "";
  }

  const svg = mono ? toMonochrome(source) : source;
  return svg.replace(
    /<svg\b/,
    `<svg class="${escapeAttribute(logoClass)}" aria-hidden="true" focusable="false"`
  );
}

function renderBrandRail({ mono = false, className = "brand-rail", logoClass = "brand-rail-logo" } = {}) {
  const logo = renderInlineLogo({ mono, logoClass });

  if (!logo) {
    return "";
  }

  return `<div class="${escapeAttribute(className)}" aria-hidden="true">${logo}</div>`;
}

module.exports = {
  renderBrandRail,
  renderInlineLogo
};
