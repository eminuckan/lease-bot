import { createRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { agentRoute } from "./agent-route";

const InboxPanel = lazy(() => import("../features/inbox-panel").then((module) => ({ default: module.InboxPanel })));

function AgentInboxPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading inbox...</div>}>
      <InboxPanel />
    </Suspense>
  );
}

export const agentInboxRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/inbox",
  component: AgentInboxPage,
});
