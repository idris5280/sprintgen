import type { TeamLocation } from "@/types";

export interface WeatherData {
  locationId: string;
  displayLabel: string;
  lookupLocation: string;
  city: string;
  region: string;
  tempF: number;
  conditionText: string;
  weatherCode: number;
  isDay: boolean;
  highF: number;
  lowF: number;
  localTime?: string;
  lastUpdated?: string;
  isHQ: boolean;
}

const CACHE_KEY = "scrum-studio-lobby-weather-cache";
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  timestamp: number;
  data: WeatherData;
}
type Cache = Record<string, CacheEntry>;

function readCache(): Cache {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cache) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Cache) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

export async function fetchWeatherForLocation(
  loc: TeamLocation,
): Promise<WeatherData> {
  const lookupCity = loc.weatherLookupCity.trim();
  if (!lookupCity) {
    throw new Error("Weather lookup city is blank.");
  }

  const cache = readCache();
  const cacheKey = `${loc.id}:${lookupCity.toLowerCase()}`;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  const res = await fetch(
    `/api/weather?location=${encodeURIComponent(lookupCity)}`,
  );
  if (!res.ok) {
    throw new Error(`Weather request failed (${res.status})`);
  }
  const payload = (await res.json()) as Omit<
    WeatherData,
    "locationId" | "displayLabel" | "lookupLocation" | "isHQ"
  >;
  const data: WeatherData = {
    locationId: loc.id,
    displayLabel: loc.displayLabel,
    lookupLocation: lookupCity,
    isHQ: loc.isHQ,
    ...payload,
  };
  cache[cacheKey] = { timestamp: Date.now(), data };
  writeCache(cache);
  return data;
}
