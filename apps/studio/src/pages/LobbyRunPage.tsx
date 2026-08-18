import { Button, Text } from "@fluentui/react-components";
import { ArrowMaximize20Regular, Home20Regular, Settings20Regular } from "@fluentui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { LobbyBackground } from "../components/LobbyBackground";
import { normalizeLobbySettings } from "../lobbySettings";
import type { LobbyLocation, LobbySettings, TriviaQuestion } from "../types";

const labels: Record<LobbySettings["meetingType"], string> = { "daily-standup": "Daily Standup", "sprint-planning": "Sprint Planning", "sprint-review": "Sprint Review", retrospective: "Retrospective", "backlog-refinement": "Backlog Refinement", "knowledge-share": "Knowledge Share" };
const fallbackTrivia: Array<TriviaQuestion & { categoryId: LobbySettings["triviaCategories"][number] }> = [
  { categoryId: "general-knowledge", category: "General Knowledge", question: "Which language has the most native speakers?", answer: "Mandarin Chinese" },
  { categoryId: "books", category: "Books", question: "Who wrote Pride and Prejudice?", answer: "Jane Austen" },
  { categoryId: "music", category: "Music", question: "How many keys are on a standard piano?", answer: "88" },
  { categoryId: "video-games", category: "Video Games", question: "Which company created the Mario video game series?", answer: "Nintendo" },
  { categoryId: "board-games", category: "Board Games", question: "How many squares are on a chessboard?", answer: "64" },
  { categoryId: "science-nature", category: "Science & Nature", question: "How many bones are in the adult human body?", answer: "206" },
  { categoryId: "computers", category: "Computers", question: "What does CPU stand for?", answer: "Central Processing Unit" },
  { categoryId: "mathematics", category: "Mathematics", question: "What is the square root of 144?", answer: "12" },
  { categoryId: "mythology", category: "Mythology", question: "Who was the Roman god of war?", answer: "Mars" },
  { categoryId: "sports", category: "Sports", question: "How many players from one team are on a basketball court?", answer: "5" },
  { categoryId: "geography", category: "Geography", question: "What is the only continent in all four hemispheres?", answer: "Africa" },
  { categoryId: "history", category: "History", question: "In what year was the Magna Carta sealed?", answer: "1215" },
  { categoryId: "art", category: "Art", question: "Who painted the Mona Lisa?", answer: "Leonardo da Vinci" },
  { categoryId: "animals", category: "Animals", question: "What is the fastest land animal?", answer: "Cheetah" },
  { categoryId: "vehicles", category: "Vehicles", question: "How many wheels does a standard motorcycle have?", answer: "2" }
];

function readStoredSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem("scrum-studio-lobby-config-v2") || "null") as unknown;
    return raw ? normalizeLobbySettings(raw) : null;
  } catch {
    return null;
  }
}

function targetFromSettings(settings: LobbySettings) {
  if (!settings.startTime) return Date.now() + 5 * 60 * 1000;
  const [hours, minutes] = settings.startTime.split(":").map(Number);
  const target = new Date(); target.setHours(hours || 0, minutes || 0, 0, 0);
  return target.getTime() > Date.now() ? target.getTime() : Date.now();
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function WeatherCard({ location }: { location: LobbyLocation }) {
  const weather = useQuery({ queryKey: ["weather", location.city], queryFn: async () => { const response = await fetch(`/api/weather?location=${encodeURIComponent(location.city)}`); if (!response.ok) throw new Error(); return response.json(); }, retry: 0 });
  return <div className="weather-card"><strong>{weather.data?.city || location.city}</strong>{weather.isLoading ? <Text>Loading weather...</Text> : weather.error ? <Text>Weather unavailable</Text> : <><div className="weather-temp">{weather.data.tempF}&deg;</div><Text>{weather.data.conditionText}</Text><small>H {weather.data.highF}&deg; / L {weather.data.lowF}&deg;</small></>}</div>;
}

export function LobbyRunPage() {
  const cloud = useQuery({ queryKey: ["lobby-settings"], queryFn: api.lobbySettings });
  const [localSettings, setLocalSettings] = useState<LobbySettings | null>(() => readStoredSettings());
  const settings = useMemo<LobbySettings | null>(() => {
    const raw = localSettings || cloud.data?.settings;
    return raw ? normalizeLobbySettings(raw) : null;
  }, [cloud.data, localSettings]);
  const [target, setTarget] = useState(() => settings ? targetFromSettings(settings) : 0);
  const [now, setNow] = useState(Date.now());
  const [triviaTick, setTriviaTick] = useState(0);
  const triviaQuery = useQuery({ queryKey: ["trivia", ...(settings?.triviaCategories || [])], queryFn: () => api.trivia(settings?.triviaCategories || []), enabled: Boolean(settings?.showTrivia && settings.triviaCategories.length), staleTime: 30 * 60 * 1000, retry: 0 });
  useEffect(() => { window.scrollTo({ top: 0, left: 0 }); }, []);
  useEffect(() => {
    const syncSettings = (event: StorageEvent) => {
      if (event.key === "scrum-studio-lobby-config-v2") setLocalSettings(readStoredSettings());
    };
    window.addEventListener("storage", syncSettings);
    return () => window.removeEventListener("storage", syncSettings);
  }, []);
  useEffect(() => { if (settings) setTarget(targetFromSettings(settings)); }, [settings]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const timer = window.setInterval(() => setTriviaTick((value) => value + 1), 7500); return () => window.clearInterval(timer); }, []);
  if (!settings) return <div className="lobby-run empty-run"><p>No lobby setup is saved yet.</p><Link to="/lobby"><Button appearance="primary">Open Setup</Button></Link></div>;
  const locations = settings.locations.filter((item) => item.city.trim());
  const selectedFallback = fallbackTrivia.filter((item) => settings.triviaCategories.includes(item.categoryId));
  const trivia = triviaQuery.data?.questions.length ? triviaQuery.data.questions : selectedFallback.length ? selectedFallback : fallbackTrivia;
  const currentTrivia = trivia[Math.floor(triviaTick / 2) % trivia.length];
  const showingAnswer = triviaTick % 2 === 1;
  const countdownActive = target > now;
  return (
    <div className="lobby-run">
      <LobbyBackground background={settings.background} />
      <div className="lobby-background-veil" aria-hidden="true" />
      <nav className="lobby-nav"><Link to="/"><Button appearance="subtle" icon={<Home20Regular />}>Home</Button></Link><Link to="/lobby"><Button appearance="subtle" icon={<Settings20Regular />}>Setup</Button></Link><Button appearance="subtle" icon={<ArrowMaximize20Regular />} onClick={() => document.documentElement.requestFullscreen?.()}>Full screen</Button></nav>
      <div className="lobby-badges">{settings.team && <span>{settings.team}</span>}<span>{labels[settings.meetingType]}</span></div>
      <main className="lobby-stage"><div className="lobby-title-block"><h1>{settings.title || labels[settings.meetingType]}</h1><Text className="countdown-label">{countdownActive ? "STARTING IN" : "WELCOME"}</Text></div>{countdownActive && <div className="countdown">{formatDuration(target - now)}</div>}{settings.prompt && <div className="prompt-card"><Text>FACILITATION PROMPT</Text><strong>{settings.prompt}</strong></div>}</main>
      <footer className="lobby-dashboard"><div className="weather-grid">{locations.map((location) => <WeatherCard key={location.id} location={location} />)}</div>{!locations.length && <div className="compact-status">Team weather is hidden until a location is added.</div>}{settings.showTrivia && <div className={`trivia-card ${showingAnswer ? "showing-answer" : ""}`}><Text>{showingAnswer ? "ANSWER" : "TRIVIA"} &middot; {currentTrivia.category.toUpperCase()}</Text><strong>{showingAnswer ? currentTrivia.answer : currentTrivia.question}</strong><small>{showingAnswer ? "Next question coming up" : "Answer reveals shortly"}</small></div>}</footer>
    </div>
  );
}
