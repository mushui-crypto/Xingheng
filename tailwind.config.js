/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        shell: "#080808",
        panel: "#101010",
        panel2: "#151515",
        line: "#2B2B2B",
        line2: "#3A3A3A",
        muted: "#A6A6A6",
        dim: "#737373",
      },
      boxShadow: {
        glow: "none",
      },
    },
  },
  plugins: [],
};
