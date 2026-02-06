import { createRoute } from "@tanstack/react-router";
import { ShowingsPanel } from "../features/showings-panel";
import { adminRoute } from "./admin-route";

export const adminShowingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/showings",
  component: ShowingsPanel,
});
