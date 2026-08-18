let started = false;

function startTelemetry() {
  if (started || !process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) return started;

  try {
    const { useAzureMonitor } = require("@azure/monitor-opentelemetry");
    useAzureMonitor();
    started = true;
  } catch (error) {
    console.error("Scrum Studio could not initialize Azure Monitor telemetry.", error);
    if (process.env.NODE_ENV === "production") throw error;
  }

  return started;
}

module.exports = { startTelemetry };
