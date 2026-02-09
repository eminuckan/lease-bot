import { Navigate, createRoute } from "@tanstack/react-router";
import { useLeaseBot } from "../state/lease-bot-context";
import { rootRoute } from "./root-route";

function IndexPage() {
  const { user, sessionLoading } = useLeaseBot();

  if (sessionLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <p className="text-sm text-muted-foreground">Restoring session...</p>
      </main>
    );
  }

  if (!user) {
    return <Navigate to="/login" />;
  }
  return <Navigate to={user.role === "admin" ? "/admin/inbox" : "/agent/appointments"} />;
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
});
