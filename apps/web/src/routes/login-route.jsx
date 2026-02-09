import { Navigate, createRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ThemeToggle } from "../components/theme-toggle";
import { useLeaseBot } from "../state/lease-bot-context";
import { rootRoute } from "./root-route";

function LoginPage() {
  const router = useRouter();
  const { user, health, apiBaseUrl, authError, setAuthError, signInEmail } = useLeaseBot();
  const [email, setEmail] = useState("admin@leasebot.com");
  const [password, setPassword] = useState("password1234");

  if (user) {
    return <Navigate to={user.role === "admin" ? "/admin/inbox" : "/agent/inbox"} />;
  }

  async function submitAuth(event) {
    event.preventDefault();
    setAuthError("");
    const currentUser = await signInEmail({ email, password });

    if (currentUser) {
      router.navigate({ to: currentUser.role === "admin" ? "/admin/inbox" : "/agent/inbox" });
    }
  }

  return (
    <main className="relative flex min-h-screen bg-background">
      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 py-4 sm:px-6">
        <div className="text-sm font-semibold tracking-tight">Lease Bot</div>
        <ThemeToggle className="rounded-md border border-border bg-muted/30 hover:bg-muted" />
      </header>

      <section className="mx-auto flex w-full max-w-md flex-1 items-center px-4 pb-12 pt-24 sm:px-6">
        <div className="w-full space-y-6">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Log in</h1>
            <p className="text-sm text-muted-foreground">Use your invited account credentials.</p>
            <p className="text-xs text-muted-foreground">API health: {health} · Base URL: {apiBaseUrl}</p>
          </div>

          <form onSubmit={submitAuth} className="space-y-4" aria-label="Login form">
            <Label className="grid gap-2 text-sm">
              Email
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </Label>

            <Label className="grid gap-2 text-sm">
              Password
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </Label>

            {authError ? <p className="text-sm text-destructive-text">{authError}</p> : null}

            <Button type="submit" className="w-full font-semibold">
              Sign in
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage
});
