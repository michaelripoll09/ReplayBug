"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { signUp } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { FieldError } from "@/components/forms/feedback";

const registerSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    email: z
      .string()
      .trim()
      .min(1, "Email is required")
      .email("Enter a valid email"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128),
    confirm: z.string().min(1, "Confirm your password"),
  })
  .refine((v) => v.password === v.confirm, {
    message: "Passwords do not match",
    path: ["confirm"],
  });

type RegisterValues = z.infer<typeof registerSchema>;

/**
 * Registration: name/email/password + client-only confirm.
 * Backend constraints (8-128 chars) mirrored; no auto-workspace is created.
 * On success the Better Auth session is live (auto-session) and we route to
 * onboarding; otherwise we fall back to an explicit login prompt.
 */
export function RegisterForm(): React.JSX.Element {
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = React.useState(false);
  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "", confirm: "" },
    mode: "onTouched",
  });

  async function onSubmit(values: RegisterValues): Promise<void> {
    setFormError(null);
    setNeedsLogin(false);
    const result = await signUp.email(
      { email: values.email, password: values.password, name: values.name },
      {
        onError: (ctx: { error: unknown }) => {
          const record = ctx.error as { message?: string } | null;
          setFormError(
            typeof record?.message === "string" && record.message.length > 0
              ? record.message
              : "Registration failed. Please try again.",
          );
        },
      },
    );
    if (result.error !== null && result.error !== undefined) {
      const record = result.error as { message?: string };
      setFormError((prev) => {
        if (prev !== null) {
          return prev;
        }
        return typeof record?.message === "string" && record.message.length > 0
          ? record.message
          : "Registration failed. Please try again.";
      });
      return;
    }
    // Auto-session expected; verify by hitting the smart root which routes to onboarding.
    // If the session cookie did not land (blocked third-party cookies, etc.),
    // surface an explicit-login fallback instead of a silent loop.
    try {
      const res = await fetch(
        `${process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"] ?? "http://localhost:4001"}/api/v1/me`,
        { credentials: "include", cache: "no-store" },
      );
      if (res.ok) {
        router.push("/onboarding/workspace");
        router.refresh();
        return;
      }
    } catch {
      // fall through to explicit login prompt
    }
    setNeedsLogin(true);
  }

  const submitting = form.formState.isSubmitting;
  const ids = {
    name: React.useId(),
    email: React.useId(),
    password: React.useId(),
    confirm: React.useId(),
  };

  return (
    <form
      onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
      noValidate
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor={ids.name}>Name</Label>
        <Input id={ids.name} autoComplete="name" {...form.register("name")} />
        <FieldError
          id={`${ids.name}-error`}
          message={form.formState.errors.name?.message}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.email}>Email</Label>
        <Input
          id={ids.email}
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          {...form.register("email")}
        />
        <FieldError
          id={`${ids.email}-error`}
          message={form.formState.errors.email?.message}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.password}>Password</Label>
        <Input
          id={ids.password}
          type="password"
          autoComplete="new-password"
          {...form.register("password")}
        />
        <FieldError
          id={`${ids.password}-error`}
          message={form.formState.errors.password?.message}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.confirm}>Confirm password</Label>
        <Input
          id={ids.confirm}
          type="password"
          autoComplete="new-password"
          {...form.register("confirm")}
        />
        <FieldError
          id={`${ids.confirm}-error`}
          message={form.formState.errors.confirm?.message}
        />
      </div>
      {formError !== null ? (
        <Alert variant="destructive" title="Registration failed">
          {formError}
        </Alert>
      ) : null}
      {needsLogin ? (
        <Alert title="Account created — sign in to continue">
          Your session was not established automatically. Please sign in with
          your new credentials.
        </Alert>
      ) : null}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
