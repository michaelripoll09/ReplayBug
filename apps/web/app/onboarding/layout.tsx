import Link from "next/link";
import { requireServerSession } from "@/lib/auth-server";
import { OnboardingProvider } from "@/components/onboarding/wizard-context";
import { ThemeToggle } from "@/components/theme-toggle";

const STEPS = ["Workspace", "Project", "Origin", "Complete"];

/** Onboarding shell: session-gated, centered, step indicator. Backend is source of truth per step. */
export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireServerSession();
  return (
    <OnboardingProvider>
      <div className="flex min-h-screen flex-col">
        <header className="flex h-14 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
          <Link href="/" className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-7 items-center justify-center rounded-md bg-zinc-900 font-mono text-sm font-bold text-white dark:bg-zinc-50 dark:text-zinc-900"
            >
              R
            </span>
            <span className="text-sm font-semibold">ReplayBug onboarding</span>
          </Link>
          <ThemeToggle />
        </header>
        <div className="mx-auto w-full max-w-2xl flex-1 p-4 md:p-8">
          <ol
            aria-label="Onboarding progress"
            className="mb-8 flex items-center gap-2 text-xs"
          >
            {STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="flex size-6 items-center justify-center rounded-full border border-zinc-300 font-mono dark:border-zinc-700"
                >
                  {i + 1}
                </span>
                <span className="font-medium">{label}</span>
                {i < STEPS.length - 1 ? (
                  <span aria-hidden="true" className="mx-1 text-zinc-400">
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {children}
        </div>
      </div>
    </OnboardingProvider>
  );
}
