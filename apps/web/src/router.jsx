import { createRouter } from "@tanstack/react-router";
import { adminRoute } from "./routes/admin-route";
import { agentRoute } from "./routes/agent-route";
import { appLayoutRoute } from "./routes/app-layout-route";
import { indexRoute } from "./routes/index-route";
import { loginRoute } from "./routes/login-route";
import { rootRoute } from "./routes/root-route";

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appLayoutRoute.addChildren([agentRoute, adminRoute])
]);

export const router = createRouter({ routeTree });
