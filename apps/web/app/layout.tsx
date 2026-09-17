import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReplayBug",
  description: "Developer observability for reproducible bugs",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
