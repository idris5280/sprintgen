import { useEffect, useMemo, useState } from "react";
import type { TeamLocation } from "@/types";
import { fetchWeatherForLocation, type WeatherData } from "@/lib/weather";
import { WeatherCard } from "./WeatherCard";

interface Props {
  locations: TeamLocation[];
}

type State =
  | { status: "loading" }
  | { status: "ready"; data: WeatherData }
  | { status: "error" };

export function TeamWeatherGrid({ locations }: Props) {
  const configuredLocations = useMemo(
    () => locations.filter((loc) => loc.weatherLookupCity?.trim()),
    [locations],
  );
  const [results, setResults] = useState<Record<string, State>>(() =>
    Object.fromEntries(configuredLocations.map((l) => [l.id, { status: "loading" }])),
  );

  useEffect(() => {
    let cancelled = false;
    setResults(
      Object.fromEntries(configuredLocations.map((l) => [l.id, { status: "loading" }])),
    );
    configuredLocations.forEach((loc) => {
      fetchWeatherForLocation(loc)
        .then((data) => {
          if (cancelled) return;
          setResults((prev) => ({
            ...prev,
            [loc.id]: { status: "ready", data },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setResults((prev) => ({ ...prev, [loc.id]: { status: "error" } }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [configuredLocations]);

  if (configuredLocations.length === 0) {
    return null;
  }

  const columnCount = Math.min(configuredLocations.length, 4);

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${columnCount}, minmax(150px, 190px))`,
        gap: "clamp(8px, 1vw, 14px)",
        width: "fit-content",
        maxWidth: "100%",
      }}
    >
      {configuredLocations.map((loc) => {
        const s = results[loc.id];
        return (
          <WeatherCard
            key={loc.id}
            location={loc}
            loading={!s || s.status === "loading"}
            error={s?.status === "error"}
            weather={s?.status === "ready" ? s.data : undefined}
          />
        );
      })}
    </div>
  );
}
