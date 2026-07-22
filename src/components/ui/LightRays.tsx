import { useEffect, useRef } from "react";
import { Mesh, Program, Renderer, Triangle } from "ogl";

type RaysOrigin = "top-center" | "top-left" | "top-right" | "left" | "right" | "bottom-left" | "bottom-center" | "bottom-right";

type LightRaysProps = {
  className?: string;
  distortion?: number;
  fadeDistance?: number;
  followMouse?: boolean;
  lightSpread?: number;
  mouseInfluence?: number;
  noiseAmount?: number;
  pulsating?: boolean;
  rayLength?: number;
  raysColor?: string;
  raysOrigin?: RaysOrigin;
  raysSpeed?: number;
  saturation?: number;
};

type LightRayUniforms = {
  iTime: { value: number };
  iResolution: { value: [number, number] };
  rayPos: { value: [number, number] };
  rayDir: { value: [number, number] };
  raysColor: { value: [number, number, number] };
  raysSpeed: { value: number };
  lightSpread: { value: number };
  rayLength: { value: number };
  pulsating: { value: number };
  fadeDistance: { value: number };
  saturation: { value: number };
  mousePos: { value: [number, number] };
  mouseInfluence: { value: number };
  noiseAmount: { value: number };
  distortion: { value: number };
};

const vertexShader = `
attribute vec2 position;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const fragmentShader = `
precision highp float;

uniform float iTime;
uniform vec2 iResolution;
uniform vec2 rayPos;
uniform vec2 rayDir;
uniform vec3 raysColor;
uniform float raysSpeed;
uniform float lightSpread;
uniform float rayLength;
uniform float pulsating;
uniform float fadeDistance;
uniform float saturation;
uniform vec2 mousePos;
uniform float mouseInfluence;
uniform float noiseAmount;
uniform float distortion;

float noise(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float rayStrength(vec2 raySource, vec2 rayRefDirection, vec2 coord, float seedA, float seedB, float speed) {
  vec2 sourceToCoord = coord - raySource;
  vec2 dirNorm = normalize(sourceToCoord);
  float cosAngle = dot(dirNorm, rayRefDirection);
  float distortedAngle = cosAngle + distortion * sin(iTime * 2.0 + length(sourceToCoord) * 0.01) * 0.2;
  float spreadFactor = pow(max(distortedAngle, 0.0), 1.0 / max(lightSpread, 0.001));
  float distanceToSource = length(sourceToCoord);
  float maxDistance = iResolution.x * rayLength;
  float lengthFalloff = clamp((maxDistance - distanceToSource) / maxDistance, 0.0, 1.0);
  float fadeFalloff = clamp((iResolution.x * fadeDistance - distanceToSource) / (iResolution.x * fadeDistance), 0.5, 1.0);
  float pulse = pulsating > 0.5 ? 0.8 + 0.2 * sin(iTime * speed * 3.0) : 1.0;
  float baseStrength = clamp(
    (0.45 + 0.15 * sin(distortedAngle * seedA + iTime * speed)) +
    (0.3 + 0.2 * cos(-distortedAngle * seedB + iTime * speed)),
    0.0,
    1.0
  );

  return baseStrength * lengthFalloff * fadeFalloff * spreadFactor * pulse;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 coord = vec2(fragCoord.x, iResolution.y - fragCoord.y);
  vec2 finalRayDir = rayDir;

  if (mouseInfluence > 0.0) {
    vec2 mouseScreenPos = mousePos * iResolution.xy;
    vec2 mouseDirection = normalize(mouseScreenPos - rayPos);
    finalRayDir = normalize(mix(rayDir, mouseDirection, mouseInfluence));
  }

  vec4 rays1 = vec4(1.0) * rayStrength(rayPos, finalRayDir, coord, 36.2214, 21.11349, 1.5 * raysSpeed);
  vec4 rays2 = vec4(1.0) * rayStrength(rayPos, finalRayDir, coord, 22.3991, 18.0234, 1.1 * raysSpeed);
  fragColor = rays1 * 0.5 + rays2 * 0.4;

  if (noiseAmount > 0.0) {
    float noiseValue = noise(coord * 0.01 + iTime * 0.1);
    fragColor.rgb *= 1.0 - noiseAmount + noiseAmount * noiseValue;
  }

  float brightness = 1.0 - coord.y / iResolution.y;
  fragColor.x *= 0.1 + brightness * 0.8;
  fragColor.y *= 0.3 + brightness * 0.6;
  fragColor.z *= 0.5 + brightness * 0.5;

  if (saturation != 1.0) {
    float gray = dot(fragColor.rgb, vec3(0.299, 0.587, 0.114));
    fragColor.rgb = mix(vec3(gray), fragColor.rgb, saturation);
  }

  fragColor.rgb *= raysColor;
}

void main() {
  vec4 color;
  mainImage(color, gl_FragCoord.xy);
  gl_FragColor = color;
}`;

export function LightRays({
  className = "",
  distortion = 0,
  fadeDistance = 1,
  followMouse = true,
  lightSpread = 1,
  mouseInfluence = 0.1,
  noiseAmount = 0,
  pulsating = false,
  rayLength = 2,
  raysColor = "#ffffff",
  raysOrigin = "top-center",
  raysSpeed = 1,
  saturation = 1,
}: LightRaysProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new Renderer({ dpr: Math.min(window.devicePixelRatio, 2), alpha: true });
    const gl = renderer.gl;
    gl.canvas.style.width = "100%";
    gl.canvas.style.height = "100%";
    container.replaceChildren(gl.canvas);

    const uniforms: LightRayUniforms = {
      iTime: { value: 0 },
      iResolution: { value: [1, 1] },
      rayPos: { value: [0, 0] },
      rayDir: { value: [0, 1] },
      raysColor: { value: hexToRgb(raysColor) },
      raysSpeed: { value: raysSpeed },
      lightSpread: { value: lightSpread },
      rayLength: { value: rayLength },
      pulsating: { value: pulsating ? 1 : 0 },
      fadeDistance: { value: fadeDistance },
      saturation: { value: saturation },
      mousePos: { value: [0.5, 0.5] },
      mouseInfluence: { value: mouseInfluence },
      noiseAmount: { value: noiseAmount },
      distortion: { value: distortion },
    };
    const geometry = new Triangle(gl);
    const program = new Program(gl, { vertex: vertexShader, fragment: fragmentShader, uniforms });
    const mesh = new Mesh(gl, { geometry, program });
    const pointerTarget = { x: 0.5, y: 0.5 };
    const pointer = { x: 0.5, y: 0.5 };

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      renderer.dpr = Math.min(window.devicePixelRatio, 2);
      renderer.setSize(width, height);
      const renderWidth = width * renderer.dpr;
      const renderHeight = height * renderer.dpr;
      uniforms.iResolution.value = [renderWidth, renderHeight];
      const origin = getRayOrigin(raysOrigin, renderWidth, renderHeight);
      uniforms.rayPos.value = origin.anchor;
      uniforms.rayDir.value = origin.direction;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      pointerTarget.x = (event.clientX - bounds.left) / bounds.width;
      pointerTarget.y = (event.clientY - bounds.top) / bounds.height;
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    if (followMouse && !prefersReducedMotion) window.addEventListener("pointermove", handlePointerMove, { passive: true });
    resize();

    let animationFrame = 0;
    const render = (time = 0) => {
      uniforms.iTime.value = time * 0.001;
      pointer.x = pointer.x * 0.92 + pointerTarget.x * 0.08;
      pointer.y = pointer.y * 0.92 + pointerTarget.y * 0.08;
      uniforms.mousePos.value = [pointer.x, pointer.y];
      renderer.render({ scene: mesh });
      animationFrame = window.requestAnimationFrame(render);
    };

    if (prefersReducedMotion) {
      renderer.render({ scene: mesh });
    } else {
      animationFrame = window.requestAnimationFrame(render);
    }

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("pointermove", handlePointerMove);
      resizeObserver.disconnect();
      program.remove();
      const loseContext = gl.getExtension("WEBGL_lose_context");
      loseContext?.loseContext();
      gl.canvas.remove();
    };
  }, [distortion, fadeDistance, followMouse, lightSpread, mouseInfluence, noiseAmount, pulsating, rayLength, raysColor, raysOrigin, raysSpeed, saturation]);

  return <div ref={containerRef} aria-hidden="true" className={`pointer-events-none h-full w-full overflow-hidden ${className}`} />;
}

function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return [1, 1, 1];
  return [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255];
}

function getRayOrigin(origin: RaysOrigin, width: number, height: number) {
  switch (origin) {
    case "top-left": return { anchor: [0, -0.2 * height] as [number, number], direction: [0, 1] as [number, number] };
    case "top-right": return { anchor: [width, -0.2 * height] as [number, number], direction: [0, 1] as [number, number] };
    case "left": return { anchor: [-0.2 * width, 0.5 * height] as [number, number], direction: [1, 0] as [number, number] };
    case "right": return { anchor: [1.2 * width, 0.5 * height] as [number, number], direction: [-1, 0] as [number, number] };
    case "bottom-left": return { anchor: [0, 1.2 * height] as [number, number], direction: [0, -1] as [number, number] };
    case "bottom-center": return { anchor: [0.5 * width, 1.2 * height] as [number, number], direction: [0, -1] as [number, number] };
    case "bottom-right": return { anchor: [width, 1.2 * height] as [number, number], direction: [0, -1] as [number, number] };
    default: return { anchor: [0.5 * width, -0.2 * height] as [number, number], direction: [0, 1] as [number, number] };
  }
}
