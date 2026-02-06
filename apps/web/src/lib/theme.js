export const THEME_STORAGE_KEY = "lease-bot-theme";

export const THEMES = {
  light: "light",
  dark: "dark"
};

function isTheme(value) {
  return value === THEMES.light || value === THEMES.dark;
}

function getSystemTheme() {
  if (typeof window === "undefined") {
    return THEMES.light;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? THEMES.dark : THEMES.light;
}

export function resolvePreferredTheme() {
  if (typeof window === "undefined") {
    return THEMES.light;
  }

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(storedTheme)) {
      return storedTheme;
    }
  } catch {
    return getSystemTheme();
  }

  return getSystemTheme();
}

export function applyTheme(theme) {
  if (typeof document === "undefined") {
    return;
  }

  const resolvedTheme = isTheme(theme) ? theme : THEMES.light;
  const root = document.documentElement;
  root.classList.toggle(THEMES.dark, resolvedTheme === THEMES.dark);
  root.dataset.theme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
}

export function setThemePreference(theme) {
  const resolvedTheme = isTheme(theme) ? theme : THEMES.light;
  applyTheme(resolvedTheme);

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);
  } catch {
    return;
  }
}

export function getThemeFromDom() {
  if (typeof document === "undefined") {
    return THEMES.light;
  }

  return document.documentElement.classList.contains(THEMES.dark) ? THEMES.dark : THEMES.light;
}
