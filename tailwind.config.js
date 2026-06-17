/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        shell: "#0B1118",
        panel: "#111827",
        line: "#1F2937",
        muted: "#9CA3AF",
      },
      boxShadow: {
        glow: "0 0 36px rgba(0, 200, 150, 0.14)",
      },
    },
  },
  plugins: [],
};
