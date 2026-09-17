"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Theme switcher: light / dark / system via next-themes. No flash (see layout). */
export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const cycle =
    theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${theme ?? "system"}. Activate to switch to ${cycle}.`}
      title={`Theme: ${theme ?? "system"} (switch to ${cycle})`}
      onClick={() => setTheme(cycle)}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
