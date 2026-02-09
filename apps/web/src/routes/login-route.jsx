import { Navigate, createRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
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
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8 sm:px-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex justify-end">
            <ThemeToggle />
          </div>
          <CardTitle className="text-xl">Lease Bot Login</CardTitle>
          <CardDescription className="text-sm">
            API health: {health} · Base URL: {apiBaseUrl}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitAuth} className="space-y-4" aria-label="Login form">
            <Label className="grid gap-1.5 text-sm">
              Email
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </Label>

            <Label className="grid gap-1.5 text-sm">
              Password
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </Label>

            {authError ? <p className="text-xs text-destructive-text">{authError}</p> : null}

            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage
});
