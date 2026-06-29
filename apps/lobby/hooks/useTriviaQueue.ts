import { useEffect, useRef, useState } from "react";
import { TRIVIA_FALLBACK, type TriviaItem } from "@/lib/triviaFallback";
import {
  DEFAULT_TRIVIA_CATEGORIES,
  TRIVIA_CATEGORY_NAMES,
} from "@/lib/triviaCategories";


function decodeEntities(s: string): string {
  if (typeof document === "undefined") {
    return s
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

interface OpenTdbResult {
  response_code: number;
  results: Array<{
    category: string;
    question: string;
    correct_answer: string;
  }>;
}

async function fetchBatch(categories: number[]): Promise<TriviaItem[]> {
  if (categories.length === 0) throw new Error("no trivia categories enabled");
  const cat = categories[Math.floor(Math.random() * categories.length)];
  const url = `https://opentdb.com/api.php?amount=10&type=multiple&difficulty=easy&category=${cat}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("trivia fetch failed");
  const data = (await res.json()) as OpenTdbResult;
  if (data.response_code !== 0 || !data.results?.length) {
    throw new Error("trivia empty response");
  }
  return data.results.map((r) => ({
    question: decodeEntities(r.question),
    answer: decodeEntities(r.correct_answer),
    category: decodeEntities(r.category) || TRIVIA_CATEGORY_NAMES[cat] || "Trivia",
  }));
}

interface UseTriviaQueueResult {
  current: TriviaItem | null;
  revealed: boolean;
  reveal: () => void;
  loading: boolean;
}

export function useTriviaQueue(opts: {
  enabled: boolean;
  active: boolean;
  rotateMs?: number;
  categories?: number[];
}): UseTriviaQueueResult {
  const {
    enabled,
    active,
    rotateMs = 30_000,
    categories = DEFAULT_TRIVIA_CATEGORIES,
  } = opts;
  const [queue, setQueue] = useState<TriviaItem[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const fetched = useRef(false);

  useEffect(() => {
    if (!enabled || fetched.current) return;
    fetched.current = true;
    setLoading(true);
    fetchBatch(categories)
      .then((items) => setQueue(items))
      .catch(() => setQueue(shuffle(TRIVIA_FALLBACK)))
      .finally(() => setLoading(false));
  }, [enabled, categories]);

  useEffect(() => {
    if (!enabled || !active || queue.length === 0) return;
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % queue.length);
      setRevealed(false);
    }, rotateMs);
    return () => clearInterval(id);
  }, [enabled, active, queue.length, rotateMs]);


  const current = queue.length > 0 ? queue[index % queue.length] : null;
  return {
    current,
    revealed,
    reveal: () => setRevealed(true),
    loading,
  };
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
