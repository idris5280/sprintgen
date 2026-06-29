import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useFadingAudio } from "@/lib/audio";
import { Pause, Play, Music2 } from "lucide-react";

interface Props {
  title: string;
  artist: string;
  src: string | null;
  unavailableMessage?: string;
}

export function MusicPlayer({ title, artist, src, unavailableMessage }: Props) {
  const { isPlaying, status, volume, play, pause, setVolume, hasAudio } = useFadingAudio(src);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-card/70 p-5 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Music2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Now playing
          </div>
          <div className="truncate text-base font-semibold text-foreground">{title || "—"}</div>
          <div className="truncate text-xs text-muted-foreground">{artist || "Unknown artist"}</div>
        </div>
      </div>

      {hasAudio ? (
        <>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant={isPlaying ? "secondary" : "default"}
              onClick={isPlaying ? pause : play}
            >
              {isPlaying ? (
                <>
                  <Pause className="mr-1 h-4 w-4" /> Pause
                </>
              ) : (
                <>
                  <Play className="mr-1 h-4 w-4" /> Play
                </>
              )}
            </Button>
            <div className="flex flex-1 items-center gap-2">
              <span className="text-xs text-muted-foreground">Vol</span>
              <Slider
                value={[Math.round(volume * 100)]}
                onValueChange={(v) => setVolume((v[0] ?? 0) / 100)}
                max={100}
                step={1}
              />
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Status: <span className="text-foreground/80">{status}</span>
          </div>
        </>
      ) : (
        <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {unavailableMessage ?? "No playable source. Upload an MP3 in Setup to enable playback."}
        </div>
      )}
    </div>
  );
}
