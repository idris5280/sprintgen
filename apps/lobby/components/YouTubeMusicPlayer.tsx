import { useEffect, useRef, useState } from "react";
import { ExternalLink, Music2 } from "lucide-react";
import { buildYouTubeWatchUrl } from "@/lib/youtube";

type YouTubePlayer = {
  destroy: () => void;
};

type YouTubePlayerConstructor = new (
  element: HTMLElement,
  options: {
    videoId: string;
    playerVars: Record<string, string | number>;
    events: {
      onError: (event: { data: number }) => void;
    };
  },
) => YouTubePlayer;

declare global {
  interface Window {
    YT?: {
      Player?: YouTubePlayerConstructor;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeIframeApiPromise: Promise<void> | null = null;

function loadYouTubeIframeApi() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube player requires a browser."));
  }

  if (window.YT?.Player) {
    return Promise.resolve();
  }

  if (!youtubeIframeApiPromise) {
    youtubeIframeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;

      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        resolve();
      };

      if (document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        return;
      }

      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("YouTube player script could not load."));
      document.head.appendChild(script);
    });
  }

  return youtubeIframeApiPromise;
}

interface Props {
  youtubeVideoId: string;
  songTitle: string;
  artist: string;
  youtubeUrl?: string;
}

export function YouTubeMusicPlayer({
  youtubeVideoId,
  songTitle,
  artist,
  youtubeUrl,
}: Props) {
  const playerMountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const [playerError, setPlayerError] = useState<number | null>(null);
  const [apiLoadFailed, setApiLoadFailed] = useState(false);
  const watchUrl = youtubeUrl || buildYouTubeWatchUrl(youtubeVideoId);
  const playbackBlocked = Boolean(playerError || apiLoadFailed);

  useEffect(() => {
    let cancelled = false;
    setPlayerError(null);
    setApiLoadFailed(false);

    loadYouTubeIframeApi()
      .then(() => {
        if (cancelled || !playerMountRef.current || !window.YT?.Player) return;

        playerRef.current?.destroy();
        playerRef.current = new window.YT.Player(playerMountRef.current, {
          videoId: youtubeVideoId,
          playerVars: {
            playsinline: 1,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            origin: window.location.origin,
          },
          events: {
            onError: (event) => {
              if (!cancelled) {
                playerRef.current?.destroy();
                playerRef.current = null;
                setPlayerError(event.data);
              }
            },
          },
        });
      })
      .catch(() => {
        if (!cancelled) setApiLoadFailed(true);
      });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [youtubeVideoId]);

  return (
    <div
      className="flex min-w-0 flex-col rounded-xl border border-white/10 bg-card/70 backdrop-blur"
      style={{
        width: "clamp(280px, 28vw, 440px)",
        maxWidth: "100%",
        padding: "clamp(10px, 1.2vh, 16px)",
        gap: "clamp(8px, 1vh, 12px)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Music2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-[0.25em] text-muted-foreground">
            Now Playing
          </div>
          <div className="truncate text-sm font-semibold text-foreground">
            {songTitle || "Untitled track"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {artist || "Unknown artist"}
          </div>
        </div>
      </div>

      {playbackBlocked ? (
        <div className="rounded-lg border border-white/10 bg-black/25 p-3">
          <a
            href={watchUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Open Music Window
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      ) : (
        <div
          className="w-full self-start overflow-hidden rounded-lg border border-white/10 bg-black/40"
          style={{
            maxWidth: "100%",
            maxHeight: "clamp(120px, 22vh, 220px)",
            aspectRatio: "16 / 9",
          }}
        >
          <div
            ref={playerMountRef}
            key={youtubeVideoId}
            title={`YouTube player - ${songTitle || youtubeVideoId}`}
            className="h-full w-full"
          />
        </div>
      )}
    </div>
  );
}
