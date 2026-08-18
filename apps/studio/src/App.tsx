import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

const HomePage = lazy(() => import("./pages/HomePage").then((module) => ({ default: module.HomePage })));
const LobbyPage = lazy(() => import("./pages/LobbyPage").then((module) => ({ default: module.LobbyPage })));
const LobbyRunPage = lazy(() => import("./pages/LobbyRunPage").then((module) => ({ default: module.LobbyRunPage })));
const ReviewStartPage = lazy(() => import("./pages/ReviewStartPage").then((module) => ({ default: module.ReviewStartPage })));
const ReviewsPage = lazy(() => import("./pages/ReviewsPage").then((module) => ({ default: module.ReviewsPage })));
const ReviewEditorPage = lazy(() => import("./pages/ReviewEditorPage").then((module) => ({ default: module.ReviewEditorPage })));
const ReviewReadyPage = lazy(() => import("./pages/ReviewReadyPage").then((module) => ({ default: module.ReviewReadyPage })));

export function App() {
  return (
    <Suspense fallback={<div className="route-loading" role="status">Loading Scrum Studio...</div>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/lobby" element={<LobbyPage />} />
        <Route path="/lobby/run" element={<LobbyRunPage />} />
        <Route path="/ado-admin" element={<ReviewStartPage />} />
        <Route path="/reviews" element={<ReviewsPage />} />
        <Route path="/reviews/:id" element={<ReviewReadyPage />} />
        <Route path="/reviews/:id/edit" element={<ReviewEditorPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
