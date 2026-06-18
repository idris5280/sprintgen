# SprintGen

SprintGen builds polished sprint review reports from Azure DevOps facts and scrum-master-approved narrative. Scrum masters connect with a temporary PAT, choose a team and sprint, review ADO metrics and story wording, write the delivery context on screen, then generate a standalone HTML report and Presentation Mode.

The original Excel workbook generator still works as a fallback for teams that prefer spreadsheet-driven reporting. The workbook flow intentionally keeps charts out of scope. The ADO-powered flow now highlights current sprint burndown, 3-sprint velocity, completion rate, completed items, and delivered story points.

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

- Authorize with a temporary Azure DevOps PAT.
- Choose the team, work area, and sprint in a guided flow.
- Open the Sprint Review Builder directly.
- Review ADO-calculated metrics, burndown, velocity, and work items.
- Type summary, delivery updates, business value, and next steps on screen.
- Attach real ADO stories to delivery updates and next-sprint plans.
- Generate an ADO-backed standalone HTML report and Presentation Mode.
- Open the HTML preview.
- Download the standalone HTML report.
- Open Presentation Mode for same-day screen sharing.

The workbook generator remains available through its routes and CLI for teams that need a spreadsheet fallback, but it is hidden from the normal scrum master flow.

Uploaded workbooks and generated web outputs are stored under `runtime/jobs/<job-id>/` and cleaned up automatically after several hours. They are not written permanently to `output/`.

## Azure DevOps Feasibility Test

SprintGen includes a Phase 1 ADO test page:

```text
http://localhost:3000/ado-test
```

The page asks only for:

- Azure DevOps PAT
- Team
- Sprint / iteration

The organization and project are configured by environment variables:

```text
ADO_ORG=esiappdev
ADO_PROJECT=Digital Transformation
ADO_DEFAULT_TEAM=(Team7) - Sales Value Stream - Vital Signs
```

If those variables are not set, SprintGen uses those same defaults. The PAT is used only for the current request. SprintGen does not store it, log it, write it to disk, or include it in generated URLs.

The sprint field accepts either a sprint number, such as `37`, or the full iteration path:

```text
Digital Transformation\2026\2026 - Q2\Sprint 37
```

The test checks:

- team iterations through Azure DevOps REST
- Analytics metadata
- `WorkItemSnapshot` story-point burndown rows
- sample current sprint work items

This is a feasibility screen only. It does not add charts, production auth, or change the Excel report generation flow yet.

## ADO Sprint Review Builder

SprintGen includes an ADO-powered sprint review workflow:

```text
http://localhost:3000/ado-admin
```

This mode is for trusted internal development while Microsoft Entra login is intentionally out of scope. The scrum master enters a read-capable Azure DevOps PAT once, and SprintGen keeps it only in server memory for the current browser session.

The Sprint Review Builder lets the scrum master:

- authorize access to the configured ADO organization/project
- choose a readable project team from a dropdown
- unfold that team's area paths and iterations without leaving the page
- select the exact area path and sprint/iteration path
- open the review builder directly
- type the executive summary
- create up to three delivery updates
- add bullet points and business value for each update
- mark an update as `#1 priority`
- attach completed ADO stories/bugs to each delivery update
- mark whether the review includes a live demo handoff
- edit the opening remarks title/subtitle for Presentation Mode
- see the next sprint's ADO stories when the team iteration exists
- attach next sprint stories to the Looking Ahead section
- generate the ADO-backed standalone HTML report and Presentation Mode

The ADO metrics flow is scoped by team, area path, and iteration path. It currently calculates:

- velocity from the last 3 completed sprints before the selected sprint
- selected sprint burndown as the main visual highlight
- completed story/bug item count
- delivered story points
- completion rate, based on delivered story points divided by committed story points

The burndown chart animates in the browser over roughly 3 seconds to make the sprint trend more presentation-friendly. Animation is reduced for users who prefer reduced motion.

After authorizing, selecting a team, and choosing the sprint details, use `Build Review` to open the on-screen editor. After generation, SprintGen writes the job to:

```text
runtime/jobs/<job-id>/
```

Generated ADO outputs are available through:

```text
/ado-report/<job-id>
/preview/<job-id>
/download/<job-id>
/ado-present/<job-id>
```

The ADO presentation breaks the selected sprint review into full-screen sections:

- sprint title/team/date slide
- contributor recognition from ADO `AssignedTo` and `Tested By`, when available
- editable opening remarks slide
- sprint health metrics
- agile metrics story point trend
- 3-sprint velocity
- sprint review summary
- one slide per delivery update
- optional dotted `Live Demo` pause slide
- looking-ahead slide with selected next sprint ADO stories
- open-floor questions and feedback closing slide

If many ADO stories are selected under one update, SprintGen compacts them into a summary and dense story grid so the presentation remains readable on screen. Empty ADO story sections are hidden. Velocity bars animate each time the velocity slide becomes active, and motion is reduced for users who prefer reduced motion.

Security behavior:

- PAT is not stored on disk
- PAT is not logged
- PAT is not included in URLs
- PAT is cleared when the server restarts, the session expires, or the user disconnects
- the browser stores only a random HttpOnly session id cookie

Generated jobs store ADO facts and the approved narrative, not the PAT. Runtime presentation links are temporary same-day links; the downloaded standalone HTML report is the durable artifact.

## Live Azure App

The current hosted MVP is available at:

```text
https://sprintgen.orangeriver-b6b98f37.eastus.azurecontainerapps.io/
```

Azure resources:

- Resource group: `sprintgen-rg`
- Container Apps environment: `sprintgen-env`
- Container App: `sprintgen`
- Region: `eastus`

The live app is currently deployed from `.azure/containerapp-runtime.yml`. It runs the official Playwright container image and pulls the public GitHub `main` branch at startup. This keeps the app online even though ACR cloud builds are blocked on the current subscription.

For a fuller production setup, use the included `Dockerfile` to build a custom image in CI, push it to Azure Container Registry, and point the Container App at that image.

## Presentation Mode

Workbook-generated reports include a `Select a mode:` area with three Presentation Mode links:

- `Light`
- `Dark`
- `Prismatic`

These open a full-screen browser presentation where each major sprint section fills the viewport like a slide. Use ArrowDown, PageDown, or Space to move forward. Use ArrowUp or PageUp to move backward. The Previous and Next buttons also work on desktop and mobile.

Workbook Presentation Mode uses the uploaded workbook data for the current generated job. The links are temporary runtime links intended for same-day presentations:

```text
/present/<job-id>?vibe=light
/present/<job-id>?vibe=dark
/present/<job-id>?vibe=prismatic
```

If `vibe` is missing or invalid, SprintGen defaults to `prismatic`.

ADO-generated sprint reviews use:

```text
/ado-present/<job-id>?vibe=light
/ado-present/<job-id>?vibe=dark
/ado-present/<job-id>?vibe=prismatic
```

The ADO presentation uses the selected sprint metrics, animated burndown, animated 3-sprint velocity, approved summary, delivery updates, business value, selected completed ADO stories, selected next sprint ADO stories, and contributor names from ADO `AssignedTo` plus `Tested By` when available.

The Presentation Mode screen does not change the downloadable report. The standalone HTML report remains the durable screen-friendly artifact.

Presentation Mode keeps the visual layer CSS-only. It does not add icon libraries, image assets, emoji decorations, chart dashboards, or extra maintained slide content. The ADO deck only uses the focused burndown and velocity visuals generated from ADO data.

## Generate From The CLI

The original command-line workbook workflow still works:

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

- `GET /` - PAT-first SprintGen authorization screen
- `GET /ado-admin` - same PAT-first screen when disconnected; guided team/sprint selection when connected
- `POST /ado-admin/connect` - create the temporary in-memory PAT session
- `POST /ado-admin/disconnect` - clear the temporary PAT session
- `GET /ado-admin/scope?team=<teamName>` - return area paths and iterations for the selected team
- `POST /ado-admin/preview` - legacy alias that now opens the Sprint Review Builder
- `POST /ado-admin/review` - open the Sprint Review Builder for the selected team/area/sprint
- `POST /ado-admin/generate-report` - generate ADO-backed HTML report, with PDF attempted as a legacy optional artifact
- `GET /ado-report/:id` - ADO report result page
- `GET /ado-present/:id` - ADO Presentation Mode
- `GET /ado-test` - ADO feasibility test
- `POST /generate` - upload workbook and generate report
- `GET /template` - download the sample workbook
- `GET /preview/:id` - open generated HTML preview
- `GET /present/:id` - open workbook-generated Presentation Mode
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

This repo also includes `.azure/containerapp-runtime.yml`, which documents the current live MVP deployment configuration.
