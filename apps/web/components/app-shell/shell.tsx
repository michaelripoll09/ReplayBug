import { Sidebar } from "./sidebar";
import { Header } from "./header";

/** Dashboard shell: compact sidebar + header + content. Desktop-first, drawer on mobile. */
export function AppShell({
  breadcrumb,
  children,
}: {
  breadcrumb: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 border-r border-zinc-200 dark:border-zinc-800 md:block">
        <div className="sticky top-0 h-screen overflow-y-auto">
          <Sidebar />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Header breadcrumb={breadcrumb} />
        <main className="mx-auto w-full max-w-5xl flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
