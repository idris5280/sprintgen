# Scrum Studio

Scrum Studio combines two internal scrum tools:

- **Lobby**: a screen-shared ceremony countdown with prompts, trivia, and compact team weather.
- **Review Builder**: a flexible sprint review workspace for delivery updates, screenshots, risks, metrics, demos, readiness, HTML reports, and Presentation Mode.

The working application uses React, TypeScript, Vite, and Fluent UI v9. Generated HTML reports and Presentation Mode use independent renderers so they remain standalone and can evolve separately.

## Local development

Requirements:

- Node.js 22
- Azure CLI when testing Azure DevOps or Blob Storage locally

Install and build:

```powershell
npm.cmd install
npm.cmd --prefix apps/studio install
npm.cmd run build:studio
```

Run:

```powershell
npm.cmd start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

For live React development, run the API and Vite in separate terminals:

```powershell
npm.cmd start
npm.cmd run dev:studio
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173).

Local development uses `az login` through `DefaultAzureCredential`. Browser-entered Azure DevOps credentials are not accepted. Manual reviews work without Azure DevOps access. Local drafts use `runtime/cloud-dev` as an Azure Blob substitute; production never uses that directory.

Optional development identity settings:

```text
SCRUM_STUDIO_DEV_USER_ID=local-dev
SCRUM_STUDIO_DEV_USER_NAME=Local developer
SCRUM_STUDIO_DEV_DATA_DIR=<optional local cloud-store substitute>
```

## Azure configuration

Production requires:

```text
NODE_ENV=production
AZURE_CLIENT_ID=<user-assigned-managed-identity-client-id>
ADO_ORG=<azure-devops-organization>
ADO_PROJECT=<azure-devops-project>
AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net
AZURE_STORAGE_CONTAINER=<private-container>
APPLICATIONINSIGHTS_CONNECTION_STRING=<application-insights-connection-string>
```

Azure Container Apps Easy Auth supplies the immutable user identity. The user-assigned managed identity reads Azure DevOps and writes private per-user review data to Blob Storage. Production fails closed when Easy Auth identity headers or storage configuration are missing.

The managed identity must be added to Azure DevOps with deliberately limited project, team, work-item, and Analytics read permissions.

## Main routes

- `/` - tool picker
- `/lobby` - Lobby setup
- `/lobby/run` - full-screen Lobby
- `/ado-admin` - manual or ADO review start
- `/reviews` - private saved review library
- `/reviews/:id/edit` - Review Builder
- `/reviews/:id/preview` - standalone HTML report
- `/reviews/:id/present?vibe=spotlight` - Spotlight Mode
- `/reviews/:id/present?vibe=light|blue|prismatic` - classic presentation styles

Authenticated JSON APIs live under `/api`. Liveness is `/health/live`; readiness, including Blob connectivity, is `/health/ready`.

## Deployment

The multi-stage Dockerfile builds the Fluent application and runs the server as a non-root user on the Playwright `1.60.0` image. The image contains the application at build time, has no application home directory, and never downloads source during startup.

Terraform configuration and the Azure Cloud Shell deployment scripts are in `infra/`. They adopt the existing `rg-scrumstudio` resources by name and configure the application runtime, Blob protection, probes, telemetry, and pilot scaling. Easy Auth, its Entra authorization group and credential, and existing Container App secrets remain externally managed by Cyber and are explicitly excluded from deployment ownership.

Build and publish immutable images through the company pipeline and Azure Container Registry.

## Artifact boundary

Operational UI code does not enter generated artifacts. The server exposes these framework-neutral renderer contracts:

- `renderHtmlReport(reviewSnapshot)`
- `renderPresentation(reviewSnapshot, theme)`
- `generatePdf(htmlArtifactPath, pdfArtifactPath)`

The snapshot is versioned, contains approved narrative plus ADO facts, and contains no authentication material.
