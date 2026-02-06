import { createRoute } from "@tanstack/react-router";
import { InboxPanel } from "../features/inbox-panel";
import { adminRoute } from "./admin-route";

export const adminInboxRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/inbox",
  component: InboxPanel,
});
