import { createRoute } from "@tanstack/react-router";
import { AssignmentPanel } from "../features/assignment-panel";
import { InboxPanel } from "../features/inbox-panel";
import { ShowingsPanel } from "../features/showings-panel";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { useLeaseBot } from "../state/lease-bot-context";
import { appLayoutRoute } from "./app-layout-route";
import { useState } from "react";

function AdminPage() {
  const { isAdmin } = useLeaseBot();
  const [panel, setPanel] = useState("inbox");

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Admin Protected Route</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-700">403: your role does not allow admin access.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Admin View</CardTitle>
          <CardDescription>Modular route with mobile action clusters</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="tablist" aria-label="Admin panels" data-testid="admin-panel-switcher">
            <Button
              type="button"
              role="tab"
              aria-selected={panel === "inbox"}
              variant={panel === "inbox" ? "default" : "outline"}
              onClick={() => setPanel("inbox")}
            >
              Inbox
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={panel === "assignment"}
              variant={panel === "assignment" ? "default" : "outline"}
              onClick={() => setPanel("assignment")}
            >
              Assignment
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={panel === "showings"}
              variant={panel === "showings" ? "default" : "outline"}
              onClick={() => setPanel("showings")}
            >
              Showings
            </Button>
          </div>
        </CardContent>
      </Card>

      {panel === "inbox" ? <InboxPanel /> : null}
      {panel === "assignment" ? <AssignmentPanel /> : null}
      {panel === "showings" ? <ShowingsPanel /> : null}
    </section>
  );
}

export const adminRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/admin",
  component: AdminPage
});
