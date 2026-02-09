import { createRouter } from "@tanstack/react-router";
import { adminRoute, adminIndexRoute } from "./routes/admin-route";
import { adminInboxRoute } from "./routes/admin-inbox-route";
import { adminAssignmentsRoute } from "./routes/admin-assignments-route";
import { adminShowingsRoute } from "./routes/admin-showings-route";
import { adminPlatformRoute } from "./routes/admin-platform-route";
import { adminUsersRoute } from "./routes/admin-users-route";
import { agentRoute, agentIndexRoute } from "./routes/agent-route";
import { agentInboxRoute } from "./routes/agent-inbox-route";
import { agentAppointmentsRoute } from "./routes/agent-appointments-route";
import { agentAvailabilityRoute } from "./routes/agent-availability-route";
import { appLayoutRoute } from "./routes/app-layout-route";
import { indexRoute } from "./routes/index-route";
import { loginRoute } from "./routes/login-route";
import { inviteRoute } from "./routes/invite-route";
import { rootRoute } from "./routes/root-route";

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  inviteRoute,
  appLayoutRoute.addChildren([
    adminRoute.addChildren([
      adminIndexRoute,
      adminInboxRoute,
      adminAssignmentsRoute,
      adminShowingsRoute,
      adminPlatformRoute,
      adminUsersRoute,
    ]),
    agentRoute.addChildren([
      agentIndexRoute,
      agentInboxRoute,
      agentAppointmentsRoute,
      agentAvailabilityRoute,
    ]),
  ]),
]);

export const router = createRouter({ routeTree });
