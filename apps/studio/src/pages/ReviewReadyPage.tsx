import { Badge, Button, Card, Text, Title1 } from "@fluentui/react-components";
import { ArrowDownload20Regular, Edit20Regular, SlideText20Regular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorState, LoadingState, StudioShell } from "../components/StudioShell";

const DEFAULT_PRESENTATION_COLOR = "#0076C0";
const COLOR_PRESETS = [
  { name: "Express Blue", value: "#0076C0" },
  { name: "Cyan", value: "#06B6D4" },
  { name: "Indigo", value: "#6366F1" },
  { name: "Teal", value: "#0F766E" },
  { name: "Crimson", value: "#DC143C" },
  { name: "Violet", value: "#7C3AED" },
  { name: "Bulls Red", value: "#CE1141" },
  { name: "Hot Pink", value: "#FF69B4" }
] as const;

export function ReviewReadyPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["review", id], queryFn: () => api.getReview(id), refetchOnMount: "always" });
  const [selectedColor, setSelectedColor] = useState(DEFAULT_PRESENTATION_COLOR);
  const [saveMessage, setSaveMessage] = useState("Saved to this review");
  const savedColor = (query.data?.review.presentation?.color || DEFAULT_PRESENTATION_COLOR).toUpperCase();
  const colorMutation = useMutation({
    mutationFn: ({ color, etag }: { color: string; etag: string }) => api.savePresentation(id, color, etag),
    onMutate: () => setSaveMessage("Saving color..."),
    onSuccess: (record) => {
      queryClient.setQueryData(["review", id], record);
      setSelectedColor((record.review.presentation?.color || DEFAULT_PRESENTATION_COLOR).toUpperCase());
      setSaveMessage("Saved to this review");
    },
    onError: () => setSaveMessage("Color was not saved. Try again.")
  });

  useEffect(() => {
    setSelectedColor(savedColor);
  }, [savedColor]);

  if (query.isLoading) return <StudioShell><LoadingState label="Opening review" /></StudioShell>;
  if (query.error || !query.data) return <StudioShell><ErrorState error={query.error} onRetry={() => query.refetch()} /></StudioShell>;

  const review = query.data.review;
  const ready = review.status === "ready";
  const colorIsDirty = selectedColor.toUpperCase() !== savedColor;
  const colorUrl = `/reviews/${id}/present?vibe=color&color=${selectedColor.slice(1)}`;
  const chooseColor = (color: string) => {
    colorMutation.reset();
    setSelectedColor(color.toUpperCase());
    setSaveMessage("Color selected. Save it to this review.");
  };
  const saveColor = () => {
    if (!colorIsDirty || colorMutation.isPending) return;
    colorMutation.mutate({ color: selectedColor, etag: query.data.etag });
  };

  return (
    <StudioShell>
      <Card className="ready-card">
        <Badge appearance="filled" color={ready ? "success" : "informative"}>{ready ? "REVIEW READY" : "CLOUD DRAFT"}</Badge>
        <Title1>{ready ? `${review.sprintName || "Sprint Spotlight"} is ready.` : `${review.sprintName || "Sprint Spotlight"} is saved.`}</Title1>
        <Text size={400}>{review.team || "Manual review"} | Last updated {new Date(review.updatedAt).toLocaleString()}</Text>
        <div className="ready-actions"><Link to={`/reviews/${id}/edit`}><Button appearance={ready ? "secondary" : "primary"} icon={<Edit20Regular />}>Edit review</Button></Link>{ready && <><a href={`/reviews/${id}/preview`} target="_blank" rel="noreferrer"><Button appearance="primary">Open HTML report</Button></a><a href={`/reviews/${id}/download-html`}><Button icon={<ArrowDownload20Regular />}>Download HTML</Button></a></>}</div>
        {ready && (
          <div className="presentation-modes">
            <div className="presentation-style-picker">
              <div className="presentation-style-heading">
                <Text weight="semibold">Presentation style</Text>
                <Text size={200}>Choose how this review appears on screen.</Text>
              </div>

              <section className="color-theme-panel" aria-labelledby="color-theme-title">
                <div className="color-theme-heading">
                  <div>
                    <Text id="color-theme-title" weight="semibold">Color</Text>
                    <Text size={200}>Choose one solid color for this review.</Text>
                  </div>
                  <code>{selectedColor}</code>
                </div>
                <div className="color-swatches" role="group" aria-label="Presentation color presets">
                  {COLOR_PRESETS.map((preset) => (
                    <button
                      className={`color-swatch${selectedColor === preset.value ? " selected" : ""}`}
                      key={preset.value}
                      type="button"
                      aria-pressed={selectedColor === preset.value}
                      onClick={() => chooseColor(preset.value)}
                    >
                      <span className="color-swatch-sample" style={{ backgroundColor: preset.value }} aria-hidden="true" />
                      <span>{preset.name}</span>
                    </button>
                  ))}
                </div>
                <div className="custom-color-row">
                  <label htmlFor="presentation-color">Custom color</label>
                  <input
                    id="presentation-color"
                    type="color"
                    value={selectedColor}
                    onChange={(event) => chooseColor(event.target.value)}
                    aria-label="Custom presentation color"
                  />
                </div>
                <div className="color-theme-actions">
                  <Button onClick={saveColor} disabled={!colorIsDirty || colorMutation.isPending}>Save color</Button>
                  <a href={colorUrl} target="_blank" rel="noreferrer"><Button appearance="primary" icon={<SlideText20Regular />}>Open Color</Button></a>
                  <Text className={colorMutation.isError ? "color-save-status error" : "color-save-status"} size={200} role="status" aria-live="polite">{saveMessage}</Text>
                </div>
              </section>

              <section className="classic-style-panel" aria-labelledby="classic-style-title">
                <Text id="classic-style-title" weight="semibold">Classic styles</Text>
                <div className="classic-style-actions">
                  <a href={`/reviews/${id}/present?vibe=blue`} target="_blank" rel="noreferrer"><Button icon={<SlideText20Regular />}>Blue</Button></a>
                  <a href={`/reviews/${id}/present?vibe=prismatic`} target="_blank" rel="noreferrer"><Button icon={<SlideText20Regular />}>Prismatic</Button></a>
                  <a href={`/reviews/${id}/present?vibe=floating-lines`} target="_blank" rel="noreferrer"><Button className="floating-lines-style-button" icon={<SlideText20Regular />}>Floating Lines</Button></a>
                  <a href={`/reviews/${id}/present?vibe=iridescence`} target="_blank" rel="noreferrer"><Button className="iridescence-style-button" icon={<SlideText20Regular />}>Iridescence</Button></a>
                </div>
              </section>
            </div>
          </div>
        )}
      </Card>
    </StudioShell>
  );
}
