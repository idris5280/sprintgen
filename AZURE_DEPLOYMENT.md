# Scrum Studio Azure Deployment Contract

This repository owns the Scrum Studio application source and Docker image. Cyber's infrastructure repository owns all Azure resources and configuration, including the Container App, Container Registry, managed identity, networking, role assignments, Easy Auth, secrets, monitoring resources, and deployment state.

## Image

- Build context: repository root
- Dockerfile: `Dockerfile`
- Image repository: `acrscrumstudio.azurecr.io/scrum-studio`
- Deploy an immutable release tag or digest rather than `latest`.
- The image listens on port `3000` and runs as non-root user `10001`.
- The image does not download source or assets during startup.

Example build command for an approved builder:

```shell
docker build --pull --tag acrscrumstudio.azurecr.io/scrum-studio:<release> .
```

## Container App

- Existing app: `ca-scrumstudio`
- Existing resource group: `rg-scrumstudio`
- Existing registry: `acrscrumstudio`
- Existing user-assigned identity: `umi-scrumstudio`
- Target port: `3000`
- CPU: `1`
- Memory: `2Gi`
- Pilot replicas: minimum `1`, maximum `3`
- Suggested HTTP concurrency target: `20`
- Liveness path: `/health/live`
- Readiness path: `/health/ready`

The existing Easy Auth configuration, Entra application, access-group restriction, authentication credential, and Container App secrets are Cyber-managed and must remain unchanged.

## Runtime Environment

Configure these values on the Container App:

```text
NODE_ENV=production
PORT=3000
AZURE_CLIENT_ID=<umi-scrumstudio client ID>
ADO_ORG=esiappdev
ADO_PROJECT=Digital Transformation
AZURE_STORAGE_ACCOUNT_URL=https://sascrumstudio.blob.core.windows.net
AZURE_STORAGE_CONTAINER=scrum-studio
APPLICATIONINSIGHTS_CONNECTION_STRING=<Cyber-managed connection string>
```

No PAT, storage-account key, client secret, or Easy Auth credential belongs in the image or source repository.

## Identity and Network Requirements

- Attach `umi-scrumstudio` to the Container App and use it for ACR image pulls.
- The identity requires read access to the `Digital Transformation` Azure DevOps project in organization `esiappdev`, including teams, iterations, area paths, work items, and Analytics.
- The identity requires Blob data access to private container `scrum-studio` in storage account `sascrumstudio`.
- The Container App must be able to reach Azure DevOps, Blob Storage, Application Insights, Open-Meteo, and the configured trivia provider over HTTPS.
- Production requests without trusted Easy Auth identity headers fail closed.

## Release Verification

After deploying a new revision:

1. Confirm an approved company user can sign in and an anonymous request is challenged.
2. Confirm `/health/live` and `/health/ready` succeed through the configured probe paths.
3. Open Team -> Sprint -> Work Areas and verify Azure DevOps data loads through managed identity.
4. Create a manual review and an ADO-backed review, then confirm both persist after a restart.
5. Verify screenshots, logos, HTML reports, PDF generation, and every presentation mode.
6. Confirm users cannot open another user's reviews or artifacts.
7. Record the deployed image digest and previous Container App revision for rollback.

## Ownership Boundary

Changes to Azure infrastructure must be made in Cyber's infrastructure repository. This application repository intentionally contains no Terraform state, Terraform deployment configuration, role-assignment automation, or scripts that modify Azure resources.
