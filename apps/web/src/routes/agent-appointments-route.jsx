import { createRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { agentRoute } from "./agent-route";

const AgentAppointmentsPanel = lazy(() =>
  import("../features/agent-appointments-panel").then((module) => ({ default: module.AgentAppointmentsPanel }))
);

function AgentAppointmentsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading appointments...</div>}>
      <AgentAppointmentsPanel />
    </Suspense>
  );
}

export const agentAppointmentsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/appointments",
  component: AgentAppointmentsPage,
});
