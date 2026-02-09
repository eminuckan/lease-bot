import { createRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { adminRoute } from "./admin-route";

const ShowingsPanel = lazy(() => import("../features/showings-panel").then((module) => ({ default: module.ShowingsPanel })));

function AdminShowingsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading showings...</div>}>
      <ShowingsPanel />
    </Suspense>
  );
}

export const adminShowingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/showings",
  component: AdminShowingsPage,
});
