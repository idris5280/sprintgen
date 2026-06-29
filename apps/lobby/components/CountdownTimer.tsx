import { useEffect, useRef } from "react";
import { useTimerState, type TimerPhase } from "@/lib/timerPhase";
import { FocusLine } from "./FocusLine";

export type { TimerPhase } from "@/lib/timerPhase";

interface Props {
  /** "HH:mm" 24h local time */
  scheduledStartTime: string;
  /** Optional ISO date "YYYY-MM-DD". Defaults to today. */
  scheduledStartDate?: string;
  arrivalBufferSeconds: number;
  fallbackCountdownMinutes?: number;
  onPhaseChange?: (phase: TimerPhase) => void;
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

export function CountdownTimer({
  scheduledStartTime,
  scheduledStartDate,
  arrivalBufferSeconds,
  fallbackCountdownMinutes = 5,
  onPhaseChange,
}: Props) {
  const fallbackStartRef = useRef(
    Date.now() + Math.max(1, fallbackCountdownMinutes) * 60 * 1000,
  );
  const { phase, preStartRemainingSec, bufferProgress } = useTimerState(
    scheduledStartTime,
    arrivalBufferSeconds,
    scheduledStartDate,
    fallbackStartRef.current,
  );

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);

  const showPreStart = phase === "preStart";
  const showBuffer = phase === "arrivalBuffer";
  const showHandoff = phase === "handoff";

  return (
    <div className="relative flex w-full flex-col items-center">
      {/* preStart layer */}
      <div
        className="flex flex-col items-center transition-all duration-700 ease-out"
        style={{
          opacity: showPreStart ? 1 : 0,
          transform: showPreStart ? "translateY(0)" : "translateY(-12px)",
          pointerEvents: showPreStart ? "auto" : "none",
          position: showPreStart ? "relative" : "absolute",
          inset: showPreStart ? undefined : 0,
        }}
        aria-hidden={!showPreStart}
      >
        <div
          className="font-medium uppercase tracking-[0.3em] text-muted-foreground"
          style={{ fontSize: "clamp(0.65rem, 0.9vw, 0.8rem)" }}
        >
          Starting in
        </div>
        <div
          className="font-semibold leading-none tabular-nums text-foreground tracking-tight"
          style={{
            fontSize: "clamp(3.5rem, 11vh, 8rem)",
            marginTop: "clamp(6px, 1vh, 14px)",
          }}
        >
          {formatDuration(preStartRemainingSec)}
        </div>
      </div>

      {/* arrivalBuffer layer */}
      <div
        className="flex flex-col items-center transition-all duration-700 ease-out"
        style={{
          opacity: showBuffer ? 1 : 0,
          transform: showBuffer ? "translateY(0)" : "translateY(8px)",
          pointerEvents: showBuffer ? "auto" : "none",
          position: showBuffer ? "relative" : "absolute",
          inset: showBuffer ? undefined : 0,
        }}
        aria-hidden={!showBuffer}
      >
        <div
          className="font-semibold tracking-tight text-white leading-[1.1] text-center"
          style={{
            fontSize: "clamp(2rem, 5.5vh, 3.75rem)",
            textShadow: "0 2px 30px rgba(180,230,255,0.25)",
          }}
        >
          A moment before we begin.
        </div>
        <div
          className="mt-3 text-white/75"
          style={{ fontSize: "clamp(0.95rem, 1.3vw, 1.15rem)" }}
        >
          Let the room come into focus.
        </div>
        <div style={{ marginTop: "clamp(14px, 2.2vh, 24px)" }}>
          <FocusLine progress={bufferProgress} />
        </div>
      </div>

      {/* handoff: rendered by LobbyScreen, intentionally empty here */}
      {showHandoff && null}
    </div>
  );
}
