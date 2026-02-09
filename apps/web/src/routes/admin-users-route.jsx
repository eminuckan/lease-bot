import { createRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { adminRoute } from "./admin-route";

const AdminUsersPanel = lazy(() =>
  import("../features/admin-users-panel").then((module) => ({ default: module.AdminUsersPanel }))
);

function AdminUsersPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading users...</div>}>
      <AdminUsersPanel />
    </Suspense>
  );
}

export const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/users",
  component: AdminUsersPage
});
