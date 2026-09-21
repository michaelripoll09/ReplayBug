import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSessionUser } from "@/lib/auth-server";
import { LoginForm } from "@/components/auth/login-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function LoginPage(): Promise<React.JSX.Element> {
  const user = await getServerSessionUser();
  if (user !== null) {
    redirect("/");
  }
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to ReplayBug</CardTitle>
          <CardDescription>
            Developer observability for reproducible bugs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <LoginForm />
          <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
            No account?{" "}
            <Link
              href="/register"
              className="font-medium underline underline-offset-4"
            >
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
