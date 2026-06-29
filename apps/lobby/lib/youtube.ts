export function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    const cleanId = (value: string | null | undefined) => {
      const id = (value || "").trim().split(/[?&#/]/)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    };

    if (parsed.hostname.includes("youtube.com")) {
      if (parsed.pathname === "/watch") {
        return cleanId(parsed.searchParams.get("v"));
      }
      if (parsed.pathname.startsWith("/embed/")) {
        return cleanId(parsed.pathname.split("/embed/")[1]);
      }
      if (parsed.pathname.startsWith("/shorts/")) {
        return cleanId(parsed.pathname.split("/shorts/")[1]);
      }
      if (parsed.pathname.startsWith("/live/")) {
        return cleanId(parsed.pathname.split("/live/")[1]);
      }
    }
    if (parsed.hostname.includes("youtu.be")) {
      return cleanId(parsed.pathname.replace("/", ""));
    }
    return null;
  } catch {
    return null;
  }
}

export function validateYouTubeUrl(url: string): boolean {
  return extractYouTubeVideoId(url) !== null;
}

export function buildYouTubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export function buildYouTubeEmbedUrl(
  videoId: string,
  options: { enableJsApi?: boolean } = {},
): string {
  const params = new URLSearchParams({
    playsinline: "1",
    controls: "1",
    rel: "0",
    modestbranding: "1",
  });

  if (options.enableJsApi) {
    params.set("enablejsapi", "1");

    if (typeof window !== "undefined" && window.location.origin) {
      params.set("origin", window.location.origin);
    }
  }

  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

export function getYouTubePlayerErrorMessage(errorCode: number | null): string {
  if (errorCode === 2) return "That YouTube link is not valid.";
  if (errorCode === 5) return "This video cannot play in the embedded HTML5 player.";
  if (errorCode === 100) return "This video is unavailable, private, or has been removed.";
  if (errorCode === 101 || errorCode === 150) {
    return "YouTube will not allow this video to play inside an embedded player.";
  }

  return "YouTube could not play this video inside the lobby.";
}

export interface YouTubeMetadata {
  title?: string;
  authorName?: string;
  thumbnailUrl?: string;
}

export async function fetchYouTubeMetadata(url: string): Promise<YouTubeMetadata> {
  const id = extractYouTubeVideoId(url);
  if (!id) return {};
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${id}`,
  )}&format=json`;
  try {
    const res = await fetch(endpoint);
    if (!res.ok) return {};
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    return {
      title: data.title,
      authorName: data.author_name,
      thumbnailUrl: data.thumbnail_url,
    };
  } catch {
    return {};
  }
}
