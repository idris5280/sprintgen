const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function hex(value) {
  return value.match(/[a-f\d]{2}/gi).map((part) => Number.parseInt(part, 16));
}

function blend(foreground, alpha, background) {
  return foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha));
}

function luminance(color) {
  const values = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

function contrast(first, second) {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

test("Floating Lines palette keeps presentation text above WCAG contrast targets", () => {
  const base = hex("ffffff");
  const businessValue = blend(hex("ffffff"), 0.9, base);
  const control = blend(hex("ffffff"), 0.92, base);

  for (const background of [base, businessValue, control]) {
    assert.ok(contrast(hex("101828"), background) >= 4.5);
  }
  assert.ok(contrast(hex("40566d"), base) >= 4.5);
  assert.ok(contrast(hex("5b32b6"), base) >= 4.5);
});

test("Iridescence local glass keeps dark presentation text readable over cyan", () => {
  const cyan = hex("06b6d4");
  const glass = blend(hex("ffffff"), 0.36, cyan);
  const denseGlass = blend(hex("ffffff"), 0.5, cyan);
  assert.ok(contrast(hex("06242c"), glass) >= 4.5);
  assert.ok(contrast(hex("06242c"), denseGlass) >= 4.5);
});

test("Floating Lines assets are local, performance-capped, and renderer-independent", () => {
  const script = fs.readFileSync(path.join(root, "public", "spotlight-present.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "spotlight-present.css"), "utf8");
  const iridescenceCss = fs.readFileSync(path.join(root, "public", "iridescence-present.css"), "utf8");
  const reportGenerator = fs.readFileSync(path.join(root, "src", "reportGenerator.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

  assert.equal(packageJson.dependencies["reveal.js"], "6.0.0");
  assert.equal(packageLock.packages["node_modules/reveal.js"].version, "6.0.0");
  assert.ok(fs.existsSync(path.join(root, "public", "vendor", "reveal", "reveal.js")));
  assert.ok(fs.existsSync(path.join(root, "public", "vendor", "reveal", "reveal.css")));
  assert.doesNotMatch(script, /https?:\/\//);
  assert.doesNotMatch(css, /https?:\/\//);
  assert.doesNotMatch(iridescenceCss, /https?:\/\//);
  assert.match(script, /transition:\s*reducedMotion\s*\?\s*"none"\s*:\s*"concave"/);
  assert.match(script, /center:\s*false/);
  assert.match(script, /width:\s*"100%"/);
  assert.match(script, /height:\s*"100%"/);
  assert.match(script, /minScale:\s*1/);
  assert.match(script, /maxScale:\s*1/);
  assert.match(script, /frameInterval = 1000 \/ 60/);
  assert.match(script, /elapsed < frameInterval/);
  assert.match(script, /document\.hidden/);
  assert.match(script, /Math\.min\(window\.devicePixelRatio \|\| 1, 1\.25\)/);
  assert.match(script, /WEBGL_lose_context/);
  assert.match(script, /const float LINE_DISTANCE = 0\.505/);
  assert.match(script, /animationSpeed:\s*\{\s*value:\s*1\s*\}/);
  assert.match(script, /bendRadius:\s*\{\s*value:\s*9\s*\}/);
  assert.match(script, /bendStrength:\s*\{\s*value:\s*-4\s*\}/);
  assert.match(script, /const float INTERACTIVE = 0\.0/);
  assert.match(script, /const float PARALLAX = 1\.0/);
  assert.match(script, /vec3\(68\.0, 72\.0, 242\.0\)/);
  assert.match(script, /vec3\(111\.0, 111\.0, 111\.0\)/);
  assert.match(script, /vec3\(106\.0, 106\.0, 106\.0\)/);
  assert.match(script, /uColor:\s*\{\s*value:\s*new Color\(6 \/ 255, 182 \/ 255, 212 \/ 255\)/);
  assert.match(script, /uMouse:\s*\{\s*value:\s*new Float32Array\(\[0\.5, 0\.5\]\)/);
  assert.match(script, /uSpeed:\s*\{\s*value:\s*0\.3\s*\}/);
  assert.doesNotMatch(script, /addEventListener\("mousemove"/);
  assert.match(reportGenerator, /"floating-lines"/);
  assert.match(reportGenerator, /"iridescence"/);
  assert.doesNotMatch(css, /backdrop-filter:\s*blur/);
  assert.doesNotMatch(iridescenceCss, /backdrop-filter:\s*blur/);
  assert.match(css, /body\.vibe-spotlight \.reveal \.slides\s*\{[\s\S]*?transform:\s*none\s*!important/);
  assert.match(css, /body\.vibe-spotlight \.reveal \.progress\s*\{[\s\S]*?color:\s*#4448f2/);
  assert.match(css, /\.floating-lines-background\s*\{[\s\S]*?background:\s*#ffffff/);
  assert.doesNotMatch(css, /text-shadow:\s*0 2px 14px/);
  assert.match(css, /body\.vibe-spotlight \.reveal \.slides > section\.ado-present-slide\s*\{[\s\S]*?display:\s*grid\s*!important/);
  assert.doesNotMatch(css, /section\.ado-present-slide\.present\s*\{[\s\S]*?display:/);
  assert.match(css, /body\.vibe-spotlight \.present-card\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(css, /body\.vibe-spotlight \.demo-handoff-slide\s*\{\s*background:\s*transparent/);
  assert.match(iridescenceCss, /body\.vibe-iridescence \.present-card\s*\{[\s\S]*?background:\s*rgba\(255, 255, 255, \.36\)/);
  assert.match(iridescenceCss, /body\.vibe-iridescence \.reveal \.progress\s*\{[\s\S]*?color:\s*#075f74/);
  assert.doesNotMatch(iridescenceCss, /iridescence-scrim/);
});
