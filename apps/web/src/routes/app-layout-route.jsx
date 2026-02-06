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
  Menu,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (!user) {
    return <Navigate to="/login" />;
  }

  const currentPath = matches[matches.length - 1]?.pathname || "";

  const showAdminNav = isAdmin;
  const showAgentNav = true;

  function handleNavigate(to) {
    router.navigate({ to });
    setMobileMenuOpen(false);
  }

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [currentPath]);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileMenuOpen]);

  function renderNavItems(showLabels) {
    return (
      <>
        {showAdminNav ? (
          <>
            {showLabels ? (
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
                    "flex w-full cursor-pointer items-center rounded-xl text-sm font-medium transition-all",
                    showLabels ? "gap-2.5 px-3 py-2.5" : "justify-center p-2.5",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-card"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  title={showLabels ? undefined : item.label}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {showLabels ? <span className="truncate">{item.label}</span> : null}
                </button>
              );
            })}
          </>
        ) : null}

        {showAdminNav && showAgentNav ? (
          <div className="my-2.5 mx-2 h-px bg-muted" />
        ) : null}

        {showAgentNav ? (
          <>
            {showLabels ? (
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
                    "flex w-full cursor-pointer items-center rounded-xl text-sm font-medium transition-all",
                    showLabels ? "gap-2.5 px-3 py-2.5" : "justify-center p-2.5",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-card"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  title={showLabels ? undefined : item.label}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {showLabels ? <span className="truncate">{item.label}</span> : null}
                </button>
              );
            })}
          </>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden flex-col bg-card transition-all duration-200 md:flex",
          sidebarOpen ? "w-56" : "w-14"
        )}
      >
        {/* Logo area */}
        <div className="flex h-14 items-center gap-2 px-3">
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
          {renderNavItems(sidebarOpen)}
        </nav>

        {/* Bottom section */}
        <div className="p-3">
          <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2">
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

      {/* Mobile overlay */}
      {mobileMenuOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-card shadow-elevated transition-transform duration-200 md:hidden",
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-14 items-center justify-between px-4">
          <span className="text-sm font-semibold tracking-tight">Lease Bot</span>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="rounded-xl p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3" aria-label="Mobile navigation">
          {renderNavItems(true)}
        </nav>

        <div className="p-3">
          <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2">
            <div
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                health === "ok" ? "bg-emerald-500" : health === "loading" ? "bg-amber-500" : "bg-red-500"
              )}
            />
            <span className="text-[11px] text-muted-foreground">API {health}</span>
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top header bar */}
        <header className="flex h-14 shrink-0 items-center justify-between bg-card px-4 shadow-card">
          <div className="flex items-center gap-3">
            {/* Mobile hamburger */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-xl p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div>
              <p className="text-sm font-medium">{user.email}</p>
              <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
            </div>
          </div>

          <div className="flex items-center gap-1">
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
        <main className="flex-1 overflow-y-auto">
          <Outlet />
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
