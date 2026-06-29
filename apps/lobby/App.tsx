import { useEffect, useRef } from "react";
import { LobbyScreen } from "@/components/LobbyScreen";
import { SetupForm } from "@/components/SetupForm";
import { useLobbyConfig } from "@/hooks/useLobbyConfig";
import { EVENT_DEFAULTS } from "@/lib/eventDefaults";
import type { LobbyConfig, ScrumEventType } from "@/types";

const eventTypes = new Set(Object.keys(EVENT_DEFAULTS));

function applyPresetFromUrl(config: LobbyConfig): LobbyConfig {
  const params = new URLSearchParams(window.location.search);
  const requestedEvent = params.get("event") || "";

  if (requestedEvent === "knowledge-share") {
    return {
      ...config,
      meetingType: "knowledge-share",
    };
  }

  if (!eventTypes.has(requestedEvent)) {
    return config;
  }

  const eventType = requestedEvent as ScrumEventType;
  const defaults = EVENT_DEFAULTS[eventType];

  return {
    ...config,
    meetingType: "scrum-event",
    eventType,
    selectedTheme: defaults.theme,
  };
}

export function App() {
  const { config, setConfig, loaded } = useLobbyConfig();
  const presetAppliedRef = useRef(false);
  const pathname = window.location.pathname.replace(/\/+$/, "");
  const isRunRoute = pathname.endsWith("/run");

  useEffect(() => {
    if (!loaded || presetAppliedRef.current || isRunRoute) {
      return;
    }

    presetAppliedRef.current = true;
    const next = applyPresetFromUrl(config);

    if (next !== config) {
      setConfig(next);
    }
  }, [config, isRunRoute, loaded, setConfig]);

  if (!loaded) {
    return null;
  }

  if (isRunRoute) {
    return <LobbyScreen config={config} />;
  }

  return (
    <div className="min-h-screen bg-background px-6 py-12">
      <SetupForm config={config} setConfig={setConfig} />
    </div>
  );
}
