"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { FieldError } from "@/components/forms/feedback";

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type LoginValues = z.infer<typeof loginSchema>;

function messageForLoginError(error: unknown): {
  message: string;
  isAuth: boolean;
} {
  const record = error as {
    status?: number;
    error?: { message?: string };
    message?: string;
  } | null;
  const status = typeof record?.status === "number" ? record.status : undefined;
  if (status === 401) {
    return { message: "Invalid email or password.", isAuth: true };
  }
  const nested =
    typeof record?.error?.message === "string" &&
    record.error.message.length > 0
      ? record.error.message
      : undefined;
  const top = typeof record?.message === "string" ? record.message : undefined;
  const detail = nested ?? top;
  if (
    typeof detail === "string" &&
    /invalid.*(email|password|credential)/i.test(detail)
  ) {
    return { message: "Invalid email or password.", isAuth: true };
  }
  return {
    message: detail ?? "Sign in failed. Please try again.",
    isAuth: false,
  };
}

/** Email+password login. RHF+Zod, inline errors, 401 vs generic. */
export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
    mode: "onTouched",
  });
  const emailId = React.useId();
  const passwordId = React.useId();
  const emailErrorId = `${emailId}-error`;
  const passwordErrorId = `${passwordId}-error`;

  async function onSubmit(values: LoginValues): Promise<void> {
    setFormError(null);
    const result = await signIn.email(
      { email: values.email, password: values.password },
      {
        onError: (ctx: { error: unknown }) => {
          const mapped = messageForLoginError(ctx.error);
          setFormError(mapped.message);
        },
      },
    );
    if (result.error !== null && result.error !== undefined) {
      const mapped = messageForLoginError(result.error);
      setFormError((prev) => prev ?? mapped.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  const submitting = form.formState.isSubmitting;
  return (
    <form
      onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
      noValidate
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor={emailId}>Email</Label>
        <Input
          id={emailId}
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={form.formState.errors.email !== undefined}
          aria-describedby={
            form.formState.errors.email !== undefined ? emailErrorId : undefined
          }
          {...form.register("email")}
        />
        <FieldError
          id={emailErrorId}
          message={form.formState.errors.email?.message}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={passwordId}>Password</Label>
        <Input
          id={passwordId}
          type="password"
          autoComplete="current-password"
          aria-invalid={form.formState.errors.password !== undefined}
          aria-describedby={
            form.formState.errors.password !== undefined
              ? passwordErrorId
              : undefined
          }
          {...form.register("password")}
        />
        <FieldError
          id={passwordErrorId}
          message={form.formState.errors.password?.message}
        />
      </div>
      {formError !== null ? (
        <Alert variant="destructive" title="Sign in failed">
          {formError}
        </Alert>
      ) : null}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
