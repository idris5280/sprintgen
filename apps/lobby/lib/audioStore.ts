// In-memory store for uploaded MP3 blob URL (session only).
let currentUrl: string | null = null;

export function setUploadedAudioUrl(url: string | null) {
  if (currentUrl && currentUrl !== url) {
    try {
      URL.revokeObjectURL(currentUrl);
    } catch {
      /* ignore */
    }
  }
  currentUrl = url;
}

export function getUploadedAudioUrl(): string | null {
  return currentUrl;
}
