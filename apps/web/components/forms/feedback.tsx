import Link from "next/link";
import { cn } from "@/lib/cn";

export function FieldError({
  message,
  id,
}: {
  message: string | undefined;
  id: string;
}): React.JSX.Element | null {
  if (message === undefined || message.length === 0) {
    return null;
  }
  return (
    <p
      id={id}
      role="alert"
      className="mt-1 text-sm text-red-600 dark:text-red-400"
    >
      {message}
    </p>
  );
}

export function FormShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-md space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description !== undefined ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function AuthLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className={cn("text-sm font-medium underline underline-offset-4")}
    >
      {children}
    </Link>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: React.ReactNode | undefined;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
      {action !== undefined ? (
        <div className="mt-4 flex justify-center">{action}</div>
      ) : null}
    </div>
  );
}
