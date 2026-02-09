import { createRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { adminRoute } from "./admin-route";

const InboxPanel = lazy(() => import("../features/inbox-panel").then((module) => ({ default: module.InboxPanel })));

function AdminInboxPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading inbox...</div>}>
      <InboxPanel />
    </Suspense>
  );
}

export const adminInboxRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/inbox",
  component: AdminInboxPage,
});
