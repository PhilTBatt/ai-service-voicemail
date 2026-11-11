// Light, dark, or whatever the device is set to. The choice is remembered on this device only
// (localStorage: a convenience, so it can be missing and that's fine). "system" is the default
// and stores nothing: tokens.css follows the device by itself. index.html runs the same rule
// before the page draws, so a dark choice never flashes white first.
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "answermate-theme";

/** What a stored value means: anything but "light" or "dark" (nothing, junk) is the device's. */
export function themeFromStored(stored: string | null): ThemeChoice {
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function readTheme(): ThemeChoice {
  try {
    return themeFromStored(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system"; // storage blocked (a private window, say)
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Not remembered, but still applied for this visit.
  }
}
