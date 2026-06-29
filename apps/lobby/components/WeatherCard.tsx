import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { TeamLocation } from "@/types";
import type { WeatherData } from "@/lib/weather";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Moon,
  Sun,
} from "lucide-react";

interface Props {
  location: TeamLocation;
  weather?: WeatherData;
  loading?: boolean;
  error?: boolean;
}

function WeatherIcon({ weather }: { weather: WeatherData }) {
  const code = Number(weather.weatherCode);
  const className = "h-8 w-8 shrink-0 text-primary";

  if (code === 0) {
    return weather.isDay ? <Sun className={className} /> : <Moon className={className} />;
  }

  if ([1, 2].includes(code)) {
    return weather.isDay ? <CloudSun className={className} /> : <CloudMoon className={className} />;
  }

  if ([45, 48].includes(code)) {
    return <CloudFog className={className} />;
  }

  if ([51, 53, 55, 56, 57].includes(code)) {
    return <CloudDrizzle className={className} />;
  }

  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return <CloudRain className={className} />;
  }

  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    return <CloudSnow className={className} />;
  }

  if ([95, 96, 99].includes(code)) {
    return <CloudLightning className={className} />;
  }

  return <Cloud className={className} />;
}

export function WeatherCard({ location, weather, loading, error }: Props) {
  const lookupCity = location.weatherLookupCity.trim();
  const displayLabel = weather?.city || lookupCity;

  return (
    <div
      className="relative flex min-w-0 flex-col justify-between rounded-xl border border-white/10 bg-card/70 backdrop-blur"
      style={{
        padding: "clamp(10px, 1.2vh, 16px)",
        gap: "clamp(4px, 0.6vh, 8px)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">
            {displayLabel}
          </h3>
          <p className="truncate text-[10px] text-muted-foreground">
            {lookupCity}
          </p>
        </div>
        {location.isHQ && (
          <Badge className="bg-primary text-primary-foreground text-[9px] px-1.5 py-0">
            HQ
          </Badge>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
      )}

      {!loading && error && (
        <div className="text-[10px] text-muted-foreground">
          Weather unavailable
        </div>
      )}

      {!loading && !error && weather && (
        <>
          <div className="flex items-center gap-2">
            <WeatherIcon weather={weather} />
            <span
              className="font-semibold leading-none text-foreground tabular-nums"
              style={{ fontSize: "clamp(1.4rem, 2.2vw, 2rem)" }}
            >
              {weather.tempF}&deg;
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{weather.conditionText}</span>
            <span className="whitespace-nowrap tabular-nums">
              H {weather.highF}&deg; / L {weather.lowF}&deg;
            </span>
          </div>
        </>
      )}
    </div>
  );
}
