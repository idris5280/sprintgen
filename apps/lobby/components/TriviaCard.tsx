import { useTriviaQueue } from "@/hooks/useTriviaQueue";

interface Props {
  active: boolean;
  categories?: number[];
}

export function TriviaCard({ active, categories }: Props) {
  const { current, revealed, reveal, loading } = useTriviaQueue({
    enabled: true,
    active,
    categories,
  });

  return (
    <div
      className="lobby-prompt mt-3 rounded-xl border border-white/10 bg-card/60 backdrop-blur transition-all duration-700"
      style={{
        maxWidth: "min(560px, 90%)",
        padding: "clamp(8px, 1.2vh, 14px) clamp(14px, 2vw, 22px)",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div
          className="font-medium uppercase tracking-[0.22em] text-muted-foreground"
          style={{ fontSize: "clamp(0.6rem, 0.8vw, 0.7rem)" }}
        >
          Trivia
        </div>
        {current && (
          <div
            className="rounded-full border border-white/10 px-2 py-0.5 text-muted-foreground"
            style={{ fontSize: "clamp(0.55rem, 0.7vw, 0.65rem)" }}
          >
            {current.category}
          </div>
        )}
      </div>

      <div key={current?.question ?? "loading"} className="trivia-fade">
        <p
          className="mt-1 font-medium text-foreground line-clamp-2"
          style={{ fontSize: "clamp(0.9rem, 1.2vw, 1.15rem)", lineHeight: 1.3 }}
        >
          {current?.question ?? (loading ? "Loading trivia…" : "")}
        </p>

        {current && (
          <div className="mt-1.5 flex items-center gap-3">
            {!revealed ? (
              <button
                type="button"
                onClick={reveal}
                className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline transition-colors"
                style={{ fontSize: "clamp(0.65rem, 0.85vw, 0.78rem)" }}
              >
                Reveal answer
              </button>
            ) : (
              <span
                className="text-foreground/80"
                style={{ fontSize: "clamp(0.7rem, 0.95vw, 0.85rem)" }}
              >
                <span className="text-muted-foreground">Answer: </span>
                {current.answer}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
