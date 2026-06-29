import { useCallback, useEffect, useRef, useState } from "react";

const FADE_MS = 3000;
const FADE_STEPS = 30;

export function useFadingAudio(src: string | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fadeTimerRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolumeState] = useState(0.7);
  const [status, setStatus] = useState<"idle" | "playing" | "paused" | "fading-in" | "fading-out">(
    "idle",
  );

  // (Re)create audio element when src changes
  useEffect(() => {
    if (!src) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setIsPlaying(false);
      setStatus("idle");
      return;
    }
    const audio = new Audio(src);
    audio.loop = true;
    audio.volume = 0;
    audioRef.current = audio;
    setIsPlaying(false);
    setStatus("idle");
    return () => {
      audio.pause();
      if (fadeTimerRef.current) window.clearInterval(fadeTimerRef.current);
    };
  }, [src]);

  const clearFade = () => {
    if (fadeTimerRef.current) {
      window.clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  };

  const fadeTo = useCallback(
    (target: number, onDone?: () => void) => {
      const audio = audioRef.current;
      if (!audio) return;
      clearFade();
      const start = audio.volume;
      const delta = target - start;
      let step = 0;
      fadeTimerRef.current = window.setInterval(() => {
        step++;
        const next = start + (delta * step) / FADE_STEPS;
        audio.volume = Math.max(0, Math.min(1, next));
        if (step >= FADE_STEPS) {
          clearFade();
          audio.volume = Math.max(0, Math.min(1, target));
          onDone?.();
        }
      }, FADE_MS / FADE_STEPS);
    },
    [],
  );

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 0;
    audio.play().then(() => {
      setIsPlaying(true);
      setStatus("fading-in");
      fadeTo(volume, () => setStatus("playing"));
    }).catch(() => {
      setStatus("idle");
    });
  }, [fadeTo, volume]);

  const pause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setStatus("fading-out");
    fadeTo(0, () => {
      audio.pause();
      setIsPlaying(false);
      setStatus("paused");
    });
  }, [fadeTo]);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    const audio = audioRef.current;
    if (audio && (status === "playing" || status === "fading-in")) {
      audio.volume = v;
    }
  }, [status]);

  return { isPlaying, status, volume, play, pause, setVolume, hasAudio: !!src };
}
