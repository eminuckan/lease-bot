import { createRoute } from "@tanstack/react-router";
import { AdminUsersPanel } from "../features/admin-users-panel";
import { adminRoute } from "./admin-route";

export const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/users",
  component: AdminUsersPanel
});
