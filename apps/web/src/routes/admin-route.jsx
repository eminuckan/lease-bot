import { Navigate, Outlet, createRoute } from "@tanstack/react-router";
import { useLeaseBot } from "../state/lease-bot-context";
import { appLayoutRoute } from "./app-layout-route";

function AdminLayout() {
  const { isAdmin } = useLeaseBot();

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16">
        <p className="text-sm font-medium text-destructive-text">403 -- your role does not allow admin access.</p>
      </div>
    );
  }

  return <Outlet />;
}

function AdminIndex() {
  return <Navigate to="/admin/inbox" />;
}

export const adminRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/admin",
  component: AdminLayout,
});

export const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminIndex,
});
