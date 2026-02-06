import { Navigate, Outlet, createRoute } from "@tanstack/react-router";
import { useLeaseBot } from "../state/lease-bot-context";
import { appLayoutRoute } from "./app-layout-route";

function AgentLayout() {
  const { canAccessAgent } = useLeaseBot();

  if (!canAccessAgent) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16">
        <p className="text-sm font-medium text-destructive-text">403 -- your role does not allow agent access.</p>
      </div>
    );
  }

  return <Outlet />;
}

function AgentIndex() {
  return <Navigate to="/agent/inbox" />;
}

export const agentRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/agent",
  component: AgentLayout,
});

export const agentIndexRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/",
  component: AgentIndex,
});
