interface Props {
  /** 0..1 */
  progress: number;
}

function clamp01(n: number) {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function FocusLine({ progress }: Props) {
  const p = clamp01(progress);
  const pct = Math.round(p * 1000) / 10;

  return (
    <div
      role="progressbar"
      aria-label="Arrival buffer progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p * 100)}
      className="focus-line"
      style={{
        width: "clamp(280px, 38vw, 560px)",
      }}
    >
      <div className="focus-line__track">
        <div
          className="focus-line__fill"
          style={{ width: `${pct}%` }}
        >
          <div className="focus-line__shimmer" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
