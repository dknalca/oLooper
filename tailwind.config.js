/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        app: "rgb(var(--color-app-rgb) / <alpha-value>)",
        surface: "rgb(var(--color-surface-rgb) / <alpha-value>)",
        "surface-hover": "rgb(var(--color-surface-hover-rgb) / <alpha-value>)",
        elevated: "rgb(var(--color-elevated-rgb) / <alpha-value>)",
        border: "rgb(var(--color-border-rgb) / <alpha-value>)",
        text: "rgb(var(--color-text-rgb) / <alpha-value>)",
        "text-secondary": "rgb(var(--color-text-secondary-rgb) / <alpha-value>)",
        accent: "rgb(var(--color-accent-rgb) / <alpha-value>)",
        "accent-hover": "rgb(var(--color-accent-hover-rgb) / <alpha-value>)",
        success: "rgb(var(--color-success-rgb) / <alpha-value>)",
        warning: "rgb(var(--color-warning-rgb) / <alpha-value>)",
        danger: "rgb(var(--color-danger-rgb) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
