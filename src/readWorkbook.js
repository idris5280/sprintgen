const XLSX = require("xlsx");

const REQUIRED_BASICS_FIELDS = [
  "TeamName",
  "SprintName",
  "DateRange",
  "TargetRollout",
  "FooterText"
];

function cleanCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [String(key).trim(), cleanCell(value)])
  );
}

function readSheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    return [];
  }

  return XLSX.utils
    .sheet_to_json(sheet, { defval: "", raw: false })
    .map(normalizeRow);
}

function readBasics(workbook) {
  const rows = readSheetRows(workbook, "Basics");
  const basics = {};

  rows.forEach((row) => {
    const field = cleanCell(row.Field);

    if (field) {
      basics[field] = cleanCell(row.Value);
    }
  });

  const missingFields = REQUIRED_BASICS_FIELDS.filter((field) => !basics[field]);

  if (missingFields.length > 0) {
    throw new Error(
      `Basics sheet is missing required field(s): ${missingFields.join(", ")}`
    );
  }

  return basics;
}

function readSummary(workbook) {
  return readSheetRows(workbook, "Summary")
    .map((row) => ({
      icon: cleanCell(row.Icon),
      text: cleanCell(row.Text)
    }))
    .filter((row) => row.text);
}

function readMetrics(workbook) {
  return readSheetRows(workbook, "Metrics")
    .map((row) => ({
      label: cleanCell(row.Label),
      value: cleanCell(row.Value),
      tone: cleanCell(row.Tone) || "blue"
    }))
    .filter((row) => row.label || row.value);
}

function readPlatform(workbook) {
  return readSheetRows(workbook, "Platform")
    .map((row) => ({
      icon: cleanCell(row.Icon),
      title: cleanCell(row.Title),
      text: cleanCell(row.Text)
    }))
    .filter((row) => row.title || row.text);
}

function readDelivered(workbook) {
  const sections = new Map();

  readSheetRows(workbook, "Delivered").forEach((row) => {
    const sectionLabel = cleanCell(row.SectionLabel) || "What We Delivered";
    const sectionTitle = cleanCell(row.SectionTitle);
    const bullet = cleanCell(row.Bullet);
    const businessValue = cleanCell(row.BusinessValue);

    if (!sectionTitle && !bullet && !businessValue) {
      return;
    }

    const key = `${sectionLabel}::${sectionTitle || "Delivered Work"}`;

    if (!sections.has(key)) {
      sections.set(key, {
        sectionLabel,
        sectionTitle: sectionTitle || "Delivered Work",
        bullets: [],
        businessValue: ""
      });
    }

    const section = sections.get(key);

    if (bullet) {
      section.bullets.push(bullet);
    }

    if (businessValue && !section.businessValue) {
      section.businessValue = businessValue;
    }
  });

  return Array.from(sections.values());
}

function readUpNext(workbook) {
  return readSheetRows(workbook, "UpNext")
    .map((row) => ({
      status: cleanCell(row.Status) || "Planned",
      title: cleanCell(row.Title),
      description: cleanCell(row.Description)
    }))
    .filter((row) => row.title || row.description);
}

function readDemo(workbook) {
  return readSheetRows(workbook, "Demo")
    .map((row) => cleanCell(row.Text))
    .filter(Boolean);
}

function readWorkbook(workbookPath) {
  const workbook = XLSX.readFile(workbookPath);
  const warnings = [];

  const basics = readBasics(workbook);
  const summary = readSummary(workbook);
  const metrics = readMetrics(workbook);
  const platform = readPlatform(workbook);
  const delivered = readDelivered(workbook);
  const upNext = readUpNext(workbook);
  const demo = readDemo(workbook);

  if (summary.length === 0) {
    warnings.push("Summary sheet is empty; hiding Sprint at a Glance.");
  }

  if (metrics.length === 0) {
    warnings.push("Metrics sheet is empty; hiding Sprint Health.");
  }

  if (delivered.length === 0) {
    warnings.push("Delivered sheet is empty; hiding Delivered Work.");
  }

  if (upNext.length === 0) {
    warnings.push("UpNext sheet is empty; hiding Looking Ahead.");
  }

  return {
    basics,
    summary,
    metrics,
    platform,
    delivered,
    upNext,
    demo,
    warnings,
    hasSummary: summary.length > 0,
    hasMetrics: metrics.length > 0,
    hasPlatform: platform.length > 0,
    hasDelivered: delivered.length > 0,
    hasUpNext: upNext.length > 0,
    hasDemo: demo.length > 0
  };
}

module.exports = {
  REQUIRED_BASICS_FIELDS,
  readWorkbook
};
