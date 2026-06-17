import type { CSSProperties } from "react";

type StarBorderProps = {
  className?: string;
  color?: string;
  shape?: "ellipse" | "rounded";
  speed?: string;
  thickness?: number;
};

export function StarBorder({
  className = "",
  color = "rgba(255,255,255,0.92)",
  shape = "rounded",
  speed = "6s",
  thickness = 1,
}: StarBorderProps) {
  const style = {
    "--star-border-color": color,
    "--star-border-speed": speed,
    "--star-border-thickness": `${thickness}px`,
  } as CSSProperties;

  return (
    <div className={`star-border star-border--${shape} pointer-events-none ${className}`} style={style} aria-hidden="true" />
  );
}
