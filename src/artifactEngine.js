function assertReviewSnapshot(reviewSnapshot) {
  if (!reviewSnapshot || typeof reviewSnapshot !== "object" || !reviewSnapshot.id) {
    const error = new Error("A versioned review snapshot is required to render an artifact.");
    error.code = "INVALID_REVIEW_SNAPSHOT";
    throw error;
  }

  return {
    schemaVersion: Number(reviewSnapshot.schemaVersion) || 1,
    ...reviewSnapshot
  };
}

function createArtifactEngine({ htmlRenderer, presentationRenderer, pdfGenerator }) {
  return {
    renderHtmlReport(reviewSnapshot) {
      return htmlRenderer(assertReviewSnapshot(reviewSnapshot));
    },
    renderPresentation(reviewSnapshot, theme) {
      return presentationRenderer(assertReviewSnapshot(reviewSnapshot), theme);
    },
    generatePdf(htmlArtifactPath, pdfArtifactPath) {
      return pdfGenerator(htmlArtifactPath, pdfArtifactPath);
    }
  };
}

module.exports = {
  assertReviewSnapshot,
  createArtifactEngine
};
