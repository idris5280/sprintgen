import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Text } from "@fluentui/react-components";
import { Add20Regular, Delete20Regular, Edit20Regular, Open20Regular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorState, LoadingState, StudioShell } from "../components/StudioShell";

export function ReviewsPage() {
  const queryClient = useQueryClient();
  const reviews = useQuery({ queryKey: ["reviews"], queryFn: api.listReviews });
  const remove = useMutation({ mutationFn: async (id: string) => { const current = await api.getReview(id); return api.deleteReview(id, current.etag); }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reviews"] }) });
  return (
    <StudioShell title="Saved reviews" description="Private drafts and generated artifacts saved to your Scrum Studio library." actions={<Link to="/ado-admin"><Button appearance="primary" icon={<Add20Regular />}>New review</Button></Link>}>
      {reviews.isLoading && <LoadingState label="Loading your reviews" />}
      {reviews.error && <ErrorState error={reviews.error} onRetry={() => reviews.refetch()} />}
      {!reviews.isLoading && !reviews.data?.reviews.length && <div className="state-panel"><strong>No saved reviews yet</strong><Text>Start manually or use Azure DevOps to create your first private cloud draft.</Text><Link to="/ado-admin"><Button appearance="primary">Start a review</Button></Link></div>}
      <div className="review-library">
        {(reviews.data?.reviews || []).map((review) => <Card className="review-row" key={review.id}>
          <div className="review-row-content"><div className="review-row-meta"><Badge appearance="tint" color={review.source === "ado" ? "brand" : "informative"}>{review.source === "ado" ? "ADO" : "Manual"}</Badge><Badge appearance="outline">{review.status === "ready" ? "Ready" : "Draft"}</Badge></div><h2>{review.sprintName || "Sprint Spotlight"}</h2><Text>{review.team || "Team not named"} | Updated {new Date(review.updatedAt).toLocaleString()}</Text></div>
          <div className="review-row-actions"><Link to={`/reviews/${review.id}`}><Button icon={<Open20Regular />}>Open</Button></Link><Link to={`/reviews/${review.id}/edit`}><Button icon={<Edit20Regular />}>Edit</Button></Link><Dialog><DialogTrigger disableButtonEnhancement><Button icon={<Delete20Regular />} aria-label={`Delete ${review.sprintName}`} /></DialogTrigger><DialogSurface><DialogBody><DialogTitle>Delete this review?</DialogTitle><DialogContent>This permanently removes the private review snapshot, media, HTML, and PDF artifacts from cloud storage.</DialogContent><DialogActions><DialogTrigger disableButtonEnhancement><Button>Cancel</Button></DialogTrigger><Button appearance="primary" disabled={remove.isPending} onClick={() => remove.mutate(review.id)}>Delete review</Button></DialogActions></DialogBody></DialogSurface></Dialog></div>
        </Card>)}
      </div>
    </StudioShell>
  );
}
