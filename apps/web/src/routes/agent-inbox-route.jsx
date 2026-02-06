import { createRoute } from "@tanstack/react-router";
import { InboxPanel } from "../features/inbox-panel";
import { agentRoute } from "./agent-route";

export const agentInboxRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/inbox",
  component: InboxPanel,
});
