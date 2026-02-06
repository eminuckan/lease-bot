import { createRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { AgentAppointmentsPanel } from "../features/agent-appointments-panel";
import { InboxPanel } from "../features/inbox-panel";
import { useLeaseBot } from "../state/lease-bot-context";
import { appLayoutRoute } from "./app-layout-route";

function AgentPage() {
  const { canAccessAgent, units, listings } = useLeaseBot();

  if (!canAccessAgent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent route blocked</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-700">403: your role does not allow agent access.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Agent View</CardTitle>
          <CardDescription>Mobile-first snapshot and messaging queue</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <div className="rounded-md bg-muted p-3">
            <p className="text-muted-foreground">Units loaded</p>
            <p className="text-lg font-semibold">{units.length}</p>
          </div>
          <div className="rounded-md bg-muted p-3">
            <p className="text-muted-foreground">Listings loaded</p>
            <p className="text-lg font-semibold">{listings.length}</p>
          </div>
        </CardContent>
      </Card>
      <AgentAppointmentsPanel />
      <InboxPanel />
    </section>
  );
}

export const agentRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/agent",
  component: AgentPage
});
