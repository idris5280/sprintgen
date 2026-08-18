import type { LobbySettings, Review, ReviewRecord, TriviaQuestion } from "./types";

export class ApiError extends Error {
  code: string;
  detail: string;
  status: number;

  constructor(message: string, status: number, code = "REQUEST_FAILED", detail = "") {
    super(message);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = body?.error || body || {};
    throw new ApiError(error.message || `Request failed (${response.status}).`, response.status, error.code, error.detail);
  }
  return body as T;
}

function reviewPayload(body: unknown) {
  const copy = structuredClone(body) as { narrative?: { teamLogo?: { imageData?: string; mediaRef?: string }; sections?: Array<{ imageData?: string; mediaRef?: string }> } };
  if (copy?.narrative?.teamLogo?.mediaRef) copy.narrative.teamLogo.imageData = "";
  for (const section of copy?.narrative?.sections || []) {
    if (section.mediaRef) section.imageData = "";
  }
  return copy;
}

export const api = {
  me: () => request<{ user: { id: string; name: string }; ado: { org: string; project: string } }>("/api/me"),
  teams: () => request<{ teams: Array<{ id: string; name: string }> }>("/api/ado/teams"),
  iterations: (team: string) => request<{ iterations: Array<{ id: string; name: string; path: string; attributes?: Record<string, string> }> }>(`/api/ado/iterations?team=${encodeURIComponent(team)}`),
  workAreas: (team: string) => request<{ areas: Array<{ id?: string; name?: string; path?: string; value?: string }>; defaultValue?: string }>(`/api/ado/work-areas?team=${encodeURIComponent(team)}`),
  createManual: (identity: Record<string, string>) => request<ReviewRecord>("/api/reviews", { method: "POST", body: JSON.stringify({ identity }) }),
  createAdo: (input: { team: string; sprint: string; areaPaths: string[]; reviewId?: string }, etag = "") => request<ReviewRecord>("/api/ado/review-draft", { method: "POST", headers: etag ? { "If-Match": etag } : {}, body: JSON.stringify(input) }),
  listReviews: () => request<{ reviews: Array<Pick<Review, "id" | "source" | "status" | "team" | "sprintName" | "updatedAt" | "createdAt">> }>("/api/reviews"),
  getReview: (id: string) => request<ReviewRecord>(`/api/reviews/${id}`),
  saveReview: (id: string, body: unknown, etag: string) => request<ReviewRecord>(`/api/reviews/${id}`, { method: "PUT", headers: etag ? { "If-Match": etag } : {}, body: JSON.stringify(reviewPayload(body)) }),
  savePresentation: (id: string, color: string, etag: string) => request<ReviewRecord>(`/api/reviews/${id}/presentation`, { method: "PUT", headers: etag ? { "If-Match": etag } : {}, body: JSON.stringify({ color }) }),
  deleteReview: (id: string, etag = "") => request<void>(`/api/reviews/${id}`, { method: "DELETE", headers: etag ? { "If-Match": etag } : {} }),
  refreshReview: (id: string, etag: string) => request<ReviewRecord>(`/api/reviews/${id}/refresh`, { method: "POST", headers: etag ? { "If-Match": etag } : {}, body: "{}" }),
  generateReview: (id: string, etag: string) => request<{ review: Review; etag: string; links: Record<string, string> }>(`/api/reviews/${id}/generate`, { method: "POST", headers: etag ? { "If-Match": etag } : {}, body: "{}" }),
  uploadMedia: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ mediaRef: string; url: string }>(`/api/reviews/${id}/media`, { method: "POST", body: form });
  },
  trivia: (categories: LobbySettings["triviaCategories"]) => request<{ questions: TriviaQuestion[] }>(`/api/trivia?categories=${encodeURIComponent(categories.join(","))}&amount=20`),
  lobbySettings: () => request<{ settings: LobbySettings | null; etag: string }>("/api/settings/lobby"),
  saveLobbySettings: (settings: LobbySettings, etag = "") => request<{ settings: LobbySettings; etag: string }>("/api/settings/lobby", { method: "PUT", headers: etag ? { "If-Match": etag } : {}, body: JSON.stringify({ settings }) })
};
