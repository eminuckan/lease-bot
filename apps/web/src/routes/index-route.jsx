import { Navigate, createRoute } from "@tanstack/react-router";
import { useLeaseBot } from "../state/lease-bot-context";
import { rootRoute } from "./root-route";

function IndexPage() {
  const { user } = useLeaseBot();
  if (!user) {
    return <Navigate to="/login" />;
  }
  return <Navigate to={user.role === "admin" ? "/admin" : "/agent"} />;
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage
});
