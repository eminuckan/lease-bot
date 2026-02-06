import { Link, Navigate, Outlet, createRoute, useRouter } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { useLeaseBot } from "../state/lease-bot-context";
import { rootRoute } from "./root-route";

function AppLayout() {
  const router = useRouter();
  const { user, health, signOut, refreshData, isAdmin } = useLeaseBot();

  if (!user) {
    return <Navigate to="/login" />;
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-3 pb-20 pt-4 sm:px-6 sm:pb-6">
      <header className="sticky top-0 z-20 mb-3 rounded-lg border border-border bg-card/95 p-3 backdrop-blur">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold">Lease Bot</h1>
            <p className="text-xs text-muted-foreground">
              Logged in as {user.email} ({user.role}) · API health: {health}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => router.navigate({ to: "/agent" })}>
              Agent area
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => router.navigate({ to: "/admin" })}>
              Admin area
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={refreshData}>
              Refresh data
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                await signOut();
                router.navigate({ to: "/login" });
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <Outlet />

      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-card/95 p-2 backdrop-blur sm:hidden">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-2">
          <Link
            to="/agent"
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-background text-sm font-medium [&.active]:border-primary [&.active]:text-primary"
          >
            Agent
          </Link>
          <Link
            to="/admin"
            className={`inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-background text-sm font-medium ${
              !isAdmin ? "opacity-60" : ""
            } [&.active]:border-primary [&.active]:text-primary`}
          >
            Admin
          </Link>
        </div>
      </nav>
    </main>
  );
}

export const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout
});
