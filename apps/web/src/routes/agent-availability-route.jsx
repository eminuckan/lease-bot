import { createRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { agentRoute } from "./agent-route";

const AgentAvailabilityPanel = lazy(() =>
  import("../features/agent-availability-panel").then((module) => ({ default: module.AgentAvailabilityPanel }))
);

function AgentAvailabilityPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading availability...</div>}>
      <AgentAvailabilityPanel />
    </Suspense>
  );
}

export const agentAvailabilityRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/availability",
  component: AgentAvailabilityPage,
});
