import { createRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { adminRoute } from "./admin-route";

const AssignmentPanel = lazy(() =>
  import("../features/assignment-panel").then((module) => ({ default: module.AssignmentPanel }))
);

function AdminAssignmentsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading assignments...</div>}>
      <AssignmentPanel />
    </Suspense>
  );
}

export const adminAssignmentsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/assignments",
  component: AdminAssignmentsPage,
});
