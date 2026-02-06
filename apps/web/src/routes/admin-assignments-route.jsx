import { createRoute } from "@tanstack/react-router";
import { AssignmentPanel } from "../features/assignment-panel";
import { adminRoute } from "./admin-route";

export const adminAssignmentsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/assignments",
  component: AssignmentPanel,
});
