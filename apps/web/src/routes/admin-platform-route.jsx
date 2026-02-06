import { createRoute } from "@tanstack/react-router";
import { PlatformControlsPanel } from "../features/platform-controls-panel";
import { adminRoute } from "./admin-route";

export const adminPlatformRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/platform",
  component: PlatformControlsPanel,
});
