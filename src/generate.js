const path = require("path");
const { generateReport, projectRoot } = require("./reportGenerator");

const outputDir = path.join(projectRoot, "output");
const htmlOutputPath = path.join(outputDir, "sprint-demo.html");
const pdfOutputPath = path.join(outputDir, "sprint-demo.pdf");

function resolveWorkbookPath() {
  const requestedPath = process.argv[2] || path.join("input", "sample-sprint-demo.xlsx");
  return path.resolve(projectRoot, requestedPath);
}

async function main() {
  const workbookPath = resolveWorkbookPath();
  const result = await generateReport({
    workbookPath,
    htmlOutputPath,
    pdfOutputPath
  });

  result.data.warnings.forEach((warning) => {
    console.warn(`Warning: ${warning}`);
  });

  console.log(`Generated ${path.relative(projectRoot, htmlOutputPath)}`);
  console.log(`Generated ${path.relative(projectRoot, pdfOutputPath)}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
