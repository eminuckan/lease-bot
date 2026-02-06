import { Navigate, Outlet, createRoute, useRouter, useMatches } from "@tanstack/react-router";
import {
  Inbox,
  ArrowLeftRight,
  CalendarDays,
  Settings2,
  CalendarClock,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Activity,
} from "lucide-react";
import { useState } from "react";
import { ThemeToggle } from "../components/theme-toggle";
import { Button } from "../components/ui/button";
import { useLeaseBot } from "../state/lease-bot-context";
import { cn } from "../lib/utils";
import { rootRoute } from "./root-route";

const adminNav = [
  { to: "/admin/inbox", label: "Inbox", icon: Inbox },
  { to: "/admin/assignments", label: "Assignments", icon: ArrowLeftRight },
  { to: "/admin/showings", label: "Showings", icon: CalendarDays },
  { to: "/admin/platform", label: "Platform", icon: Settings2 },
];

const agentNav = [
  { to: "/agent/inbox", label: "Inbox", icon: Inbox },
  { to: "/agent/appointments", label: "My Showings", icon: CalendarClock },
];

function AppLayout() {
  const router = useRouter();
  const matches = useMatches();
  const { user, health, signOut, isAdmin } = useLeaseBot();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  if (!user) {
    return <Navigate to="/login" />;
  }

  const currentPath = matches[matches.length - 1]?.pathname || "";

  const showAdminNav = isAdmin;
  const showAgentNav = true;

  function handleNavigate(to) {
    router.navigate({ to });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex flex-col border-r border-border bg-card transition-all duration-200",
          sidebarOpen ? "w-56" : "w-14"
        )}
      >
        {/* Logo area */}
        <div className="flex h-14 items-center gap-2 border-b border-border px-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
          </Button>
          {sidebarOpen ? (
            <span className="truncate text-sm font-semibold tracking-tight">Lease Bot</span>
          ) : null}
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3" aria-label="Main navigation">
          {showAdminNav ? (
            <>
              {sidebarOpen ? (
                <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Admin
                </p>
              ) : null}
              {adminNav.map((item) => {
                const Icon = item.icon;
                const isActive = currentPath === item.to || currentPath.startsWith(item.to + "/");
                return (
                  <button
                    key={item.to}
                    type="button"
                    onClick={() => handleNavigate(item.to)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    title={sidebarOpen ? undefined : item.label}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {sidebarOpen ? <span className="truncate">{item.label}</span> : null}
                  </button>
                );
              })}
            </>
          ) : null}

          {showAdminNav && showAgentNav ? (
            <div className="my-2 border-t border-border" />
          ) : null}

          {showAgentNav ? (
            <>
              {sidebarOpen ? (
                <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Agent
                </p>
              ) : null}
              {agentNav.map((item) => {
                const Icon = item.icon;
                const isActive = currentPath === item.to || currentPath.startsWith(item.to + "/");
                return (
                  <button
                    key={item.to}
                    type="button"
                    onClick={() => handleNavigate(item.to)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    title={sidebarOpen ? undefined : item.label}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {sidebarOpen ? <span className="truncate">{item.label}</span> : null}
                  </button>
                );
              })}
            </>
          ) : null}
        </nav>

        {/* Bottom section */}
        <div className="border-t border-border p-2">
          <div className="flex items-center gap-1">
            <div
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                health === "ok" ? "bg-emerald-500" : health === "loading" ? "bg-amber-500" : "bg-red-500"
              )}
              title={`API: ${health}`}
            />
            {sidebarOpen ? (
              <span className="truncate text-[11px] text-muted-foreground">API {health}</span>
            ) : null}
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top header bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/80 px-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm font-medium">{user.email}</p>
              <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
              onClick={async () => {
                await signOut();
                router.navigate({ to: "/login" });
              }}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});
