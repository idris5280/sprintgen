import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CountdownTimer, type TimerPhase } from "./CountdownTimer";
import { TeamWeatherGrid } from "./TeamWeatherGrid";
import { TriviaCard } from "./TriviaCard";
import { EVENT_DEFAULTS } from "@/lib/eventDefaults";
import type { LobbyConfig } from "@/types";
import { Maximize2, ArrowLeft, ArrowUpRight, Play } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

interface Props {
  config: LobbyConfig;
}

export function LobbyScreen({ config }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<TimerPhase>("preStart");
  const def = EVENT_DEFAULTS[config.eventType];

  const handlePhaseChange = useCallback((p: TimerPhase) => setPhase(p), []);

  const goFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  const prompt = config.facilitationPrompt?.trim();
  const focusMode = phase === "arrivalBuffer";
  const handoffMode = phase === "handoff";
  const boardUrl = config.azureDevOpsBoardUrl?.trim();
  const presentationHandoffUrl = config.presentationHandoffUrl?.trim();
  const isKnowledgeShare = config.meetingType === "knowledge-share";
  const teamName = config.teamName?.trim();
  const sprintName = config.sprintName?.trim();
  const lobbyTitle = isKnowledgeShare
    ? config.ksSubjectTitle?.trim() || "Knowledge Share"
    : config.meetingTitle?.trim() || def.label;
  const weatherLocations = useMemo(
    () =>
      (isKnowledgeShare
        ? config.teamLocations.filter((l) => l.isHQ)
        : config.teamLocations
      ).filter((l) => l.weatherLookupCity?.trim()),
    [config.teamLocations, isKnowledgeShare],
  );
  const hasWeatherLocations = weatherLocations.length > 0;

  return (
    <div
      ref={containerRef}
      className={`theme-${config.selectedTheme} lobby-shell relative grid w-screen overflow-hidden ${focusMode ? "arrival-focus-mode" : ""} ${handoffMode ? "handoff-mode" : ""}`}
      style={{
        height: "100dvh",
        maxHeight: "100dvh",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        padding: "clamp(12px, 2vh, 24px) clamp(20px, 4vw, 48px)",
        rowGap: "clamp(10px, 1.6vh, 20px)",
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-background/55" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.08),transparent_60%)]" />
      {/* Focus wash — only visible in arrivalBuffer */}
      <div className="lobby-focus-wash pointer-events-none absolute inset-0" aria-hidden="true" />
      {/* Handoff bloom — only visible in handoff */}
      <div className="lobby-handoff-bloom pointer-events-none absolute inset-0" aria-hidden="true" />

      {/* Top bar */}
      <div className="lobby-topbar relative z-10 flex items-center justify-between">
        {!isKnowledgeShare && (teamName || sprintName) ? (
          <div className="flex items-center gap-2">
            {teamName && (
              <Badge className="bg-primary/20 text-primary border border-primary/30">
                {teamName}
              </Badge>
            )}
            {sprintName && (
              <Badge variant="secondary">{sprintName}</Badge>
            )}
          </div>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" asChild>
            <a href="/">Home</a>
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <a href="/lobby">
              <ArrowLeft className="mr-1 h-4 w-4" /> Setup
            </a>
          </Button>
          <Button variant="secondary" size="sm" onClick={goFullscreen}>
            <Maximize2 className="mr-1 h-4 w-4" /> Full screen
          </Button>
        </div>
      </div>

      {/* Hero zone */}
      <div className="lobby-hero relative z-10 flex min-h-0 flex-col items-center justify-center text-center">
        <h1
          className={`font-semibold tracking-tight text-foreground leading-[1.05] transition-all duration-700 ease-out ${handoffMode ? "opacity-60" : ""}`}
          style={{
            fontSize: handoffMode
              ? "clamp(1rem, 1.6vw, 1.5rem)"
              : "clamp(1.75rem, 3.4vw, 3.5rem)",
          }}
        >
          {lobbyTitle}
        </h1>

        {/* Countdown / Focus Line — hidden in handoff */}
        <div
          className="transition-opacity duration-700 ease-out"
          style={{
            marginTop: "clamp(8px, 1.4vh, 18px)",
            opacity: handoffMode ? 0 : 1,
            pointerEvents: handoffMode ? "none" : "auto",
            position: handoffMode ? "absolute" : "relative",
          }}
          aria-hidden={handoffMode}
        >
          <CountdownTimer
            scheduledStartTime={config.scheduledStartTime}
            scheduledStartDate={config.scheduledStartDate}
            arrivalBufferSeconds={config.arrivalBufferSeconds}
            fallbackCountdownMinutes={config.countdownMinutes}
            onPhaseChange={handlePhaseChange}
          />
        </div>

      {/* Handoff message */}
      <div
        className="flex flex-col items-center transition-all duration-700 ease-out"
        style={{
          opacity: handoffMode ? 1 : 0,
          transform: handoffMode ? "translateY(0)" : "translateY(8px)",
          pointerEvents: handoffMode ? "auto" : "none",
          position: handoffMode ? "relative" : "absolute",
          marginTop: handoffMode ? "clamp(8px, 1.6vh, 22px)" : 0,
        }}
        aria-hidden={!handoffMode}
      >
        <div
          className="font-medium uppercase tracking-[0.32em] text-primary"
          style={{ fontSize: "clamp(0.65rem, 0.9vw, 0.8rem)" }}
        >
          Ready
        </div>
        <div
          className="font-semibold tracking-tight text-white leading-[1.05]"
          style={{
            fontSize: "clamp(2.5rem, 7vh, 5rem)",
            marginTop: "clamp(6px, 1vh, 10px)",
            textShadow: "0 2px 40px rgba(220,235,255,0.28)",
          }}
        >
          {isKnowledgeShare
            ? "Let's begin."
            : config.eventType === "sprint-review"
              ? "Begin demo."
              : "Into the board."}
        </div>
        {isKnowledgeShare && (config.ksSubjectTitle?.trim() || config.ksPresenter?.trim()) && (
          <div
            className="text-center text-white/85"
            style={{ marginTop: "clamp(10px, 1.4vh, 16px)" }}
          >
            {config.ksSubjectTitle?.trim() && (
              <div
                className="font-medium"
                style={{ fontSize: "clamp(1rem, 1.8vw, 1.5rem)" }}
              >
                {config.ksSubjectTitle}
              </div>
            )}
            {config.ksPresenter?.trim() && (
              <div
                className="uppercase tracking-[0.22em] text-white/65"
                style={{ fontSize: "clamp(0.65rem, 0.9vw, 0.8rem)", marginTop: 4 }}
              >
                Presented by {config.ksPresenter}
              </div>
            )}
          </div>
        )}
        <div style={{ marginTop: "clamp(16px, 2.2vh, 26px)" }}>
          {isKnowledgeShare ? null : config.eventType === "sprint-review" ? (
            presentationHandoffUrl ? (
              <a
                href={presentationHandoffUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-6 py-3 text-sm font-medium text-white backdrop-blur-md transition-all hover:border-white/40 hover:bg-white/10"
              >
                Open Sprint Review Presentation
                <Play className="h-4 w-4" />
              </a>
            ) : (
              <button
                type="button"
                disabled
                className="inline-flex cursor-not-allowed items-center gap-2 rounded-full border border-white/10 bg-white/5 px-6 py-3 text-sm font-medium text-white/45 backdrop-blur-md"
              >
                Add presentation link in setup
                <Play className="h-4 w-4" />
              </button>
            )
          ) : boardUrl ? (
            <a
              href={boardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-6 py-3 text-sm font-medium text-white backdrop-blur-md transition-all hover:border-white/40 hover:bg-white/10"
            >
              Open Azure DevOps Board
              <ArrowUpRight className="h-4 w-4" />
            </a>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-6 py-3 text-sm font-medium text-white backdrop-blur-md transition-all hover:border-white/40 hover:bg-white/10"
            >
              Switch to Azure DevOps
              <ArrowUpRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

        {phase === "preStart" && config.triviaEnabled ? (
          <TriviaCard active={phase === "preStart"} categories={config.triviaCategories} />
        ) : phase !== "handoff" && prompt && !isKnowledgeShare ? (
          <div
            className="lobby-prompt mt-3 rounded-xl border border-white/10 bg-card/60 backdrop-blur transition-all duration-700"
            style={{
              maxWidth: "min(560px, 90%)",
              padding: "clamp(8px, 1.2vh, 14px) clamp(14px, 2vw, 22px)",
            }}
          >
            <div
              className="font-medium uppercase tracking-[0.22em] text-muted-foreground"
              style={{ fontSize: "clamp(0.6rem, 0.8vw, 0.7rem)" }}
            >
              Prompt
            </div>
            <p
              className="mt-1 font-medium text-foreground line-clamp-2"
              style={{ fontSize: "clamp(0.9rem, 1.2vw, 1.15rem)", lineHeight: 1.3 }}
            >
              {prompt}
            </p>
          </div>
        ) : null}
      </div>

      {/* Bottom dashboard */}
      <div
        className="lobby-dashboard relative z-10 flex flex-wrap items-end"
        style={{
          gap: "clamp(12px, 1.5vw, 24px)",
          justifyContent: "flex-start",
        }}
      >
        {hasWeatherLocations && <TeamWeatherGrid locations={weatherLocations} />}
      </div>
    </div>
  );
}
