function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function metricToneClass(tone) {
  const normalized = normalizeToken(tone);
  const allowed = new Set(["green", "blue", "orange", "red", "gray"]);
  return allowed.has(normalized) ? normalized : "blue";
}

function badgeClass(status) {
  const normalized = normalizeToken(status);

  if (normalized.includes("qa")) {
    return "badge-qa";
  }

  if (normalized.includes("active") || normalized.includes("progress")) {
    return "badge-active";
  }

  if (normalized.includes("done") || normalized.includes("complete")) {
    return "badge-done";
  }

  return "badge-planned";
}

function registerHelpers(handlebars) {
  handlebars.registerHelper("metricToneClass", metricToneClass);
  handlebars.registerHelper("badgeClass", badgeClass);
}

module.exports = {
  badgeClass,
  metricToneClass,
  normalizeToken,
  registerHelpers
};
