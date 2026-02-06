import { createRoute } from "@tanstack/react-router";
import { AgentAppointmentsPanel } from "../features/agent-appointments-panel";
import { agentRoute } from "./agent-route";

export const agentAppointmentsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/appointments",
  component: AgentAppointmentsPanel,
});
