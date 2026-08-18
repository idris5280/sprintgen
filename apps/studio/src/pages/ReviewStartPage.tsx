import { Button, Field, Input, MessageBar, MessageBarBody, Text } from "@fluentui/react-components";
import { CloudArrowDown20Regular, Edit20Regular } from "@fluentui/react-icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { AdoScopePicker } from "../components/AdoScopePicker";
import { StudioShell } from "../components/StudioShell";

export function ReviewStartPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state || {}) as { mode?: string; reviewId?: string; etag?: string };
  const reviewId = state.reviewId || new URLSearchParams(location.search).get("reviewId") || "";
  const existing = useQuery({ queryKey: ["review", reviewId], queryFn: () => api.getReview(reviewId), enabled: Boolean(reviewId && !state.etag) });
  const [mode, setMode] = useState<"ado" | "manual">(state.mode === "manual" ? "manual" : "ado");
  const [identity, setIdentity] = useState({ team: "", sprint: "", startDate: "", finishDate: "" });
  const createManual = useMutation({ mutationFn: () => api.createManual(identity), onSuccess: ({ review }) => navigate(`/reviews/${review.id}/edit`) });

  return (
    <StudioShell
      title={reviewId ? "Add Azure DevOps data" : "Start a review"}
      description={mode === "ado" ? "Choose the sprint scope, then load the workspace." : "Open a blank review workspace."}
    >
      {!reviewId && (
        <div className="source-switcher" aria-label="Review source">
          <Button appearance={mode === "ado" ? "primary" : "subtle"} icon={<CloudArrowDown20Regular />} onClick={() => setMode("ado")}>Azure DevOps</Button>
          <Button appearance={mode === "manual" ? "primary" : "subtle"} icon={<Edit20Regular />} onClick={() => setMode("manual")}>Manual</Button>
        </div>
      )}
      {mode === "ado" ? (
        existing.isLoading ? <Text>Opening your saved draft...</Text> :
          existing.error ? <MessageBar intent="error"><MessageBarBody>{existing.error.message}</MessageBarBody></MessageBar> :
            <AdoScopePicker reviewId={reviewId} etag={state.etag || existing.data?.etag || ""} />
      ) : (
        <section className="workspace-card manual-start-card">
          <div className="panel-heading">
            <Text className="eyebrow">MANUAL REVIEW</Text>
            <h2>Review details</h2>
            <Text>Create the narrative now. ADO data can be added later.</Text>
          </div>
          <div className="compact-form">
            <Field label="Team name (optional)"><Input value={identity.team} onChange={(_, data) => setIdentity({ ...identity, team: data.value })} placeholder="Example: Platform Team" /></Field>
            <Field label="Sprint or review name"><Input value={identity.sprint} onChange={(_, data) => setIdentity({ ...identity, sprint: data.value })} placeholder="Sprint Spotlight" /></Field>
            <div className="two-fields">
              <Field label="Start date (optional)"><Input type="date" value={identity.startDate} onChange={(_, data) => setIdentity({ ...identity, startDate: data.value })} /></Field>
              <Field label="Finish date (optional)"><Input type="date" value={identity.finishDate} onChange={(_, data) => setIdentity({ ...identity, finishDate: data.value })} /></Field>
            </div>
          </div>
          {createManual.error && <MessageBar intent="error"><MessageBarBody>{createManual.error.message}</MessageBarBody></MessageBar>}
          <Button appearance="primary" disabled={createManual.isPending} onClick={() => createManual.mutate()}>{createManual.isPending ? "Creating workspace..." : "Open manual workspace"}</Button>
        </section>
      )}
    </StudioShell>
  );
}
