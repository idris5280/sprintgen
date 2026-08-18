import { lazy, Suspense, useEffect, useState } from "react";
import type { LobbyBackground as LobbyBackgroundName } from "../types";

const Particles = lazy(() => import("./reactbits/Particles/Particles"));
const SoftAurora = lazy(() => import("./reactbits/SoftAurora/SoftAurora"));
const MoltenMetal = lazy(() => import("./reactbits/MoltenMetal/MoltenMetal"));

export const lobbyBackgroundOptions: Array<{ value: LobbyBackgroundName; label: string }> = [
  { value: "particles", label: "Particles" },
  { value: "soft-aurora", label: "Soft Aurora" },
  { value: "molten-metal", label: "Molten Metal" }
];

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function MotionScene({ background }: { background: LobbyBackgroundName }) {
  switch (background) {
    case "particles":
      return <Particles particleCount={180} particleSpread={12} speed={0.035} particleColors={["#e7f7ff", "#37c6ed", "#7c79ff"]} particleBaseSize={72} sizeRandomness={1.4} cameraDistance={20} disableRotation />;
    case "molten-metal":
      return <MoltenMetal color1="#09265b" color2="#24bce7" color3="#dff7ff" speed={0.18} scale={3.2} detail={2.5} glow={1.1} brightness={1.05} colorMode="frost" grain grainIntensity={0.035} mouseInteraction={false} />;
    case "soft-aurora":
    default:
      return <SoftAurora speed={0.32} scale={1.35} brightness={0.72} color1="#0b3f79" color2="#23c7e8" noiseFrequency={2.1} noiseAmplitude={0.7} bandHeight={0.42} bandSpread={1.15} colorSpeed={0.55} enableMouseInteraction={false} />;
  }
}

export function LobbyBackground({ background }: { background: LobbyBackgroundName }) {
  const reducedMotion = useReducedMotion();
  const pageVisible = usePageVisible();
  return (
    <div className={`lobby-background lobby-background-${background}`} aria-hidden="true">
      {reducedMotion || !pageVisible ? <div className="lobby-background-static" /> : <Suspense fallback={<div className="lobby-background-static" />}><MotionScene key={background} background={background} /></Suspense>}
    </div>
  );
}
