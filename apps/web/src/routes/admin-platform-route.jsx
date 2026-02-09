import { createRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { adminRoute } from "./admin-route";

const PlatformControlsPanel = lazy(() =>
  import("../features/platform-controls-panel").then((module) => ({ default: module.PlatformControlsPanel }))
);

function AdminPlatformPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading platform controls...</div>}>
      <PlatformControlsPanel />
    </Suspense>
  );
}

export const adminPlatformRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/platform",
  component: AdminPlatformPage,
});
