import { useEffect, useState } from "react";

export type TimerPhase = "preStart" | "arrivalBuffer" | "handoff";

export function getScheduledTimestamp(time: string, date?: string): number {
  const [hStr, mStr] = (time || "09:00").split(":");
  const h = Number(hStr) || 0;
  const m = Number(mStr) || 0;
  const base = date ? new Date(`${date}T00:00:00`) : new Date();
  base.setHours(h, m, 0, 0);
  return base.getTime();
}

export function getTimerPhase(
  now: number,
  scheduledStartTimestamp: number,
  arrivalBufferSeconds: number,
): TimerPhase {
  if (now < scheduledStartTimestamp) return "preStart";
  if (now < scheduledStartTimestamp + arrivalBufferSeconds * 1000)
    return "arrivalBuffer";
  return "handoff";
}

export interface TimerState {
  now: number;
  startTs: number;
  bufferEndTs: number;
  phase: TimerPhase;
  /** Seconds remaining until scheduled start (preStart phase). */
  preStartRemainingSec: number;
  /** 0..1 progress through arrival buffer. */
  bufferProgress: number;
}

export function useTimerState(
  scheduledStartTime: string,
  arrivalBufferSeconds: number,
  scheduledStartDate?: string,
  fallbackStartTimestamp?: number,
): TimerState {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const startTs = scheduledStartTime?.trim()
    ? getScheduledTimestamp(scheduledStartTime, scheduledStartDate)
    : fallbackStartTimestamp ?? getScheduledTimestamp(scheduledStartTime, scheduledStartDate);
  const bufferMs = arrivalBufferSeconds * 1000;
  const bufferEndTs = startTs + bufferMs;
  const phase = getTimerPhase(now, startTs, arrivalBufferSeconds);

  const preStartRemainingSec = Math.max(0, Math.ceil((startTs - now) / 1000));
  const bufferProgress =
    bufferMs <= 0
      ? 1
      : Math.min(1, Math.max(0, (now - startTs) / bufferMs));

  return {
    now,
    startTs,
    bufferEndTs,
    phase,
    preStartRemainingSec,
    bufferProgress,
  };
}
