interface Props {
  prompt: string;
}

export function FacilitationPrompt({ prompt }: Props) {
  if (!prompt) return null;
  return (
    <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-card/60 px-6 py-5 text-center backdrop-blur">
      <div className="text-xs font-medium uppercase tracking-[0.25em] text-muted-foreground">
        Facilitation prompt
      </div>
      <p className="mt-2 text-2xl font-medium text-foreground">{prompt}</p>
    </div>
  );
}
