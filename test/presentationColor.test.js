const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PRESENTATION_COLOR,
  buildPresentationColorTokens,
  isValidPresentationColor,
  normalizePresentationColor,
  normalizePresentationVibe
} = require("../src/reportGenerator");

function hex(value) {
  return value.slice(1).match(/.{2}/g).map((part) => Number.parseInt(part, 16));
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

test("presentation colors normalize safely and Light remains a Color alias", () => {
  assert.equal(normalizePresentationColor("ce1141"), "#CE1141");
  assert.equal(normalizePresentationColor("#ff69b4"), "#FF69B4");
  assert.equal(normalizePresentationColor("not-a-color"), DEFAULT_PRESENTATION_COLOR);
  assert.equal(isValidPresentationColor("#CE1141"), true);
  assert.equal(isValidPresentationColor("CE1141"), false);
  assert.equal(normalizePresentationVibe("light"), "color");
  assert.equal(normalizePresentationVibe("color"), "color");
});

test("Color mode chooses a readable foreground for representative backgrounds", () => {
  for (const color of ["#002868", "#06B6D4", "#FFD700", "#FFFFFF", "#000000", "#777777", "#CE1141", "#FF69B4"]) {
    const tokens = buildPresentationColorTokens(color);
    assert.ok(contrast(hex(tokens.onColor), hex(tokens.color)) >= 4.5, `${tokens.onColor} should be readable on ${tokens.color}`);
  }
});
