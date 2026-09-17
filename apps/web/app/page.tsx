"use client";

import { useEffect, useState } from "react";
import { Button } from "@replaybug/ui";
import { cn } from "@/lib/cn";

export default function HomePage(): React.JSX.Element {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <main
      className={cn(
        "flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center",
      )}
    >
      <p className="rounded-full border border-zinc-300 px-3 py-1 text-xs uppercase tracking-widest dark:border-zinc-700">
        Foundation bootstrap
      </p>
      <h1 className="text-4xl font-bold tracking-tight">ReplayBug</h1>
      <p className="max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
        Developer observability for reproducible bugs
      </p>
      <div className="flex items-center gap-3">
        <Button onClick={() => setDark((value) => !value)}>
          {dark ? "Switch to light mode" : "Switch to dark mode"}
        </Button>
        <span
          aria-live="polite"
          className="text-sm text-zinc-500 dark:text-zinc-400"
        >
          {dark ? "Dark theme active" : "Light theme active"}
        </span>
      </div>
    </main>
  );
}
