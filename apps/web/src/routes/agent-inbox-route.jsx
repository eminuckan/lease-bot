import { Navigate, createRoute } from "@tanstack/react-router";
import { agentRoute } from "./agent-route";

function AgentInboxPage() {
  return <Navigate to="/agent/appointments" />;
}

export const agentInboxRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/inbox",
  component: AgentInboxPage,
});
