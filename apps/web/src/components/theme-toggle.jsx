import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "./ui/button";
import { THEMES, getThemeFromDom, setThemePreference } from "../lib/theme";

export function ThemeToggle({ className }) {
  const [theme, setTheme] = useState(() => getThemeFromDom());

  function toggleTheme() {
    const nextTheme = theme === THEMES.dark ? THEMES.light : THEMES.dark;
    setThemePreference(nextTheme);
    setTheme(nextTheme);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === THEMES.dark ? "light" : "dark"} theme`}
      aria-pressed={theme === THEMES.dark}
    >
      {theme === THEMES.dark ? (
        <Moon className="h-4 w-4" />
      ) : (
        <Sun className="h-4 w-4" />
      )}
    </Button>
  );
}
