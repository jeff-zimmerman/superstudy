import { signal, effect } from "@preact/signals";

export type Theme = "light" | "dark";

// index.html sets data-theme before first paint; start from whatever it chose
export const theme = signal<Theme>(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

effect(() => {
  document.documentElement.dataset.theme = theme.value;
  try { localStorage.setItem("theme", theme.value); } catch { /* storage unavailable */ }
});

export const toggleTheme = () => (theme.value = theme.value === "dark" ? "light" : "dark");
