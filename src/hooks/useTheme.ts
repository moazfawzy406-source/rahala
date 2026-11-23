import { useEffect, useState } from 'react';
import type { ThemeId } from '../../shared/types';

const STORAGE_KEY = 'rahhala_theme';
const THEME_META_COLORS: Record<ThemeId, string> = {
  dark: '#0C1622',
  light: '#F4F6F9',
  sepia: '#F2E9D5',
  'warm-night': '#1F1A15',
};

function readStoredTheme(): ThemeId {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (val === 'dark' || val === 'light' || val === 'sepia' || val === 'warm-night') {
      return val;
    }
  } catch {
    // ignore storage errors
  }
  return 'dark';
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', THEME_META_COLORS[theme]);
    }
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  return { theme, setTheme };
}
