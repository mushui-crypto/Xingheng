import { AuthVisual } from "../auth/AuthVisual";
import { LightRays } from "../ui/LightRays";

export function HomeLightRaysHero() {
  return (
    <section aria-label="StellaX 首页主视觉" className="relative min-h-[calc(100dvh-60px)] overflow-hidden bg-black">
      <LightRays
        className="absolute inset-0"
        distortion={0}
        fadeDistance={1.4}
        lightSpread={2}
        mouseInfluence={0.5}
        noiseAmount={0}
        pulsating={false}
        rayLength={3}
        raysColor="#ffffff"
        raysOrigin="top-center"
        raysSpeed={1}
        saturation={1}
      />
      <AuthVisual className="z-10" variant="home" />
    </section>
  );
}
