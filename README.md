# SprintGen

SprintGen turns an Excel workbook into a polished sprint demo HTML page and PDF. Scrum masters fill out spreadsheet tabs, then generate a stakeholder-ready report without editing HTML.

MVP 1 intentionally uses Sprint Health metric cards only. Velocity charts, burndown charts, and day-by-day sprint data are not required.

## Install

```bash
npm install
```

On Windows PowerShell systems that block `npm.ps1`, use `npm.cmd install` instead.

## Run The Web App Locally

```bash
npm run dev
```

Or:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

From the browser, scrum masters can:

- Download the sample workbook.
- Upload a completed `.xlsx` workbook.
- Generate a report.
- Open the HTML preview.
- Download the PDF.
- Open Presentation Mode for same-day screen sharing.

Uploaded workbooks and generated web outputs are stored under `runtime/jobs/<job-id>/` and cleaned up automatically after several hours. They are not written permanently to `output/`.

## Presentation Mode

After a successful upload, the result page includes a `Select a mode:` area with three Presentation Mode links:

- `Light`
- `Dark`
- `Prismatic`

These open a full-screen browser presentation where each major sprint section fills the viewport like a slide. Use ArrowDown, PageDown, or Space to move forward. Use ArrowUp or PageUp to move backward. The Previous and Next buttons also work on desktop and mobile.

Presentation Mode uses the uploaded workbook data for the current generated job. The links are temporary runtime links intended for same-day presentations:

```text
/present/<job-id>?vibe=light
/present/<job-id>?vibe=dark
/present/<job-id>?vibe=prismatic
```

If `vibe` is missing or invalid, SprintGen defaults to `prismatic`.

The Presentation Mode screen does not change the durable PDF output. The PDF remains the normal report layout.

Presentation Mode keeps the visual layer CSS-only. It does not add icon libraries, image assets, emoji decorations, charts, or extra maintained slide content.

## Generate From The CLI

The original command-line workflow still works:

```bash
npm run generate
```

This reads:

```text
input/sample-sprint-demo.xlsx
```

And writes:

```text
output/sprint-demo.html
output/sprint-demo.pdf
```

To generate from another workbook:

```bash
npm run generate -- input/my-team-sprint.xlsx
```

To clear generated CLI output and temporary web jobs:

```bash
npm run clean
```

## Workbook Format

The workbook should include these sheets:

- `Basics`
- `Summary`
- `Metrics`
- `Platform`
- `Delivered`
- `UpNext`
- `Demo`

### Basics

Columns: `Field`, `Value`.

Required fields:

- `TeamName`
- `SprintName`
- `DateRange`
- `TargetRollout`
- `FooterText`

Generation fails if any required field is missing or blank.

### Summary

Columns: `Icon`, `Text`.

Each row becomes a Sprint at a Glance item. If the sheet is empty, the section is hidden and a warning is shown.

### Metrics

Columns: `Label`, `Value`, `Tone`.

Each row becomes a Sprint Health card. Supported tones are:

- `green`
- `blue`
- `orange`
- `red`
- `gray`

If this sheet is empty, Sprint Health is hidden and a warning is shown.

### Platform

Columns: `Icon`, `Title`, `Text`.

Each row becomes a Platform Improvements card. This section is optional.

### Delivered

Columns: `SectionLabel`, `SectionTitle`, `Bullet`, `BusinessValue`.

Rows with the same `SectionLabel` and `SectionTitle` are grouped into one Delivered Work section. Each `Bullet` becomes a bullet. The first non-empty `BusinessValue` for that group becomes the green Business Value callout.

If this sheet is empty, Delivered Work is hidden and a warning is shown.

### UpNext

Columns: `Status`, `Title`, `Description`.

Each row becomes a Looking Ahead item. Status values containing `QA`, `Active`, `Progress`, `Done`, or `Complete` receive matching badge styling; other values use planned styling.

If this sheet is empty, Looking Ahead is hidden and a warning is shown.

### Demo

Column: `Text`.

Rows appear in the Live Demo callout. This section is optional.

## Web Routes

- `GET /` - upload page
- `POST /generate` - upload workbook and generate report
- `GET /template` - download the sample workbook
- `GET /preview/:id` - open generated HTML preview
- `GET /present/:id` - open generated Presentation Mode
- `GET /download/:id` - download generated PDF

Uploads are limited to `.xlsx` files up to 8 MB.

## Docker

The Dockerfile uses the official Playwright base image so PDF export has Chromium and the required system dependencies.

Build:

```bash
docker build -t sprintgen .
```

Run:

```bash
docker run --rm -p 3000:3000 sprintgen
```

Open:

```text
http://localhost:3000
```

## Azure Container Apps Concept

For MVP, no database, custom domain, or Azure Blob Storage is required.

Conceptual deployment path:

1. Build the Docker image.
2. Push it to Azure Container Registry.
3. Create an Azure Container Apps environment.
4. Deploy the image as a container app.
5. Set the container port to `3000`.
6. Let Azure provide the default app URL.

The app listens on `process.env.PORT || 3000`, so Azure can set the port through environment configuration.
