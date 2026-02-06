import { createRouter } from "@tanstack/react-router";
import { adminRoute, adminIndexRoute } from "./routes/admin-route";
import { adminInboxRoute } from "./routes/admin-inbox-route";
import { adminAssignmentsRoute } from "./routes/admin-assignments-route";
import { adminShowingsRoute } from "./routes/admin-showings-route";
import { adminPlatformRoute } from "./routes/admin-platform-route";
import { agentRoute, agentIndexRoute } from "./routes/agent-route";
import { agentInboxRoute } from "./routes/agent-inbox-route";
import { agentAppointmentsRoute } from "./routes/agent-appointments-route";
import { appLayoutRoute } from "./routes/app-layout-route";
import { indexRoute } from "./routes/index-route";
import { loginRoute } from "./routes/login-route";
import { rootRoute } from "./routes/root-route";

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appLayoutRoute.addChildren([
    adminRoute.addChildren([
      adminIndexRoute,
      adminInboxRoute,
      adminAssignmentsRoute,
      adminShowingsRoute,
      adminPlatformRoute,
    ]),
    agentRoute.addChildren([
      agentIndexRoute,
      agentInboxRoute,
      agentAppointmentsRoute,
    ]),
  ]),
]);

export const router = createRouter({ routeTree });
