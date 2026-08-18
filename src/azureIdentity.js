const ADO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

let credential = null;

function getAzureCredential() {
  if (credential) {
    return credential;
  }

  let DefaultAzureCredential;

  try {
    ({ DefaultAzureCredential } = require("@azure/identity"));
  } catch (error) {
    const dependencyError = new Error(
      "Azure authentication is not installed. Run npm install before using Azure DevOps or Blob Storage."
    );
    dependencyError.code = "AZURE_IDENTITY_NOT_INSTALLED";
    dependencyError.cause = error;
    throw dependencyError;
  }

  credential = new DefaultAzureCredential({
    managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined
  });
  return credential;
}

async function getAdoAuth({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    credential = null;
  }
  const token = await getAzureCredential().getToken(ADO_SCOPE);

  if (!token || !token.token) {
    const error = new Error("Azure could not issue an Azure DevOps access token.");
    error.code = "ADO_TOKEN_UNAVAILABLE";
    throw error;
  }

  return { bearerToken: token.token };
}

function resetAzureCredentialForTests() {
  credential = null;
}

module.exports = {
  ADO_SCOPE,
  getAdoAuth,
  getAzureCredential,
  resetAzureCredentialForTests
};
