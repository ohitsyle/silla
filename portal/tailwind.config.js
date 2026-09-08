/** @type {import('tailwindcss').Config} */

// Mirrors the buyer app's config on purpose: the portal's live preview
// has to be indistinguishable from the system it is selling, so both
// apps must resolve the same class names to the same token names.
//
// Every colour resolves to a CSS variable declared in src/index.css.
// Nothing here is a literal — a hex in this file would be a colour the
// preview could not re-theme, which is the portal's entire job.
//
// The `<alpha-value>` placeholder keeps Tailwind's opacity modifiers
// working (`bg-state-available/20`, `border-line/25`), which is why the
// variables hold space-separated RGB channels rather than finished
// colours.
const token = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: token("--c-bg-page"),
          page: token("--c-bg-page"),
          card: token("--c-bg-card"),
          panel: token("--c-bg-panel"),
        },
        line: token("--c-line"),
        ink: {
          primary: token("--c-ink-primary"),
          secondary: token("--c-ink-secondary"),
          muted: token("--c-ink-muted"),
        },
        accent: {
          DEFAULT: token("--c-accent"),
          ink: token("--c-accent-ink"),
        },
        // Resource states (spec §12). Distinct from `accent` on purpose:
        // a buyer whose brand colour happens to be green must not make
        // "available" and "branding" indistinguishable.
        state: {
          available: token("--c-state-available"),
          reserved: token("--c-state-reserved"),
          occupied: token("--c-state-occupied"),
          unavailable: token("--c-state-unavailable"),
          overstay: token("--c-state-overstay"),
        },
      },

      // The design-system scales spec §20 lists as still open. Declared
      // here so components reference names, not magic numbers.
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        raised: "var(--shadow-md), var(--highlight-top)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        smooth: "var(--ease-in-out)",
      },
      transitionDuration: {
        instant: "var(--dur-instant)",
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};
