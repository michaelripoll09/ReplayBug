import { requireServerSession } from "@/lib/auth-server";

/** Protected app segment: session checked server-side before any sensitive render. */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireServerSession();
  return <>{children}</>;
}
