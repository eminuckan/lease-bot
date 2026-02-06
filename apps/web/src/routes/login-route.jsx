import { Navigate, createRoute, useRouter } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ThemeToggle } from "../components/theme-toggle";
import { useLeaseBot } from "../state/lease-bot-context";
import { rootRoute } from "./root-route";
import { useState } from "react";

function LoginPage() {
  const router = useRouter();
  const { user, health, apiBaseUrl, setAuthError, signInEmail, signUpEmail } = useLeaseBot();
  const [formMode, setFormMode] = useState("login");
  const [email, setEmail] = useState("agent@example.com");
  const [password, setPassword] = useState("password1234");
  const [name, setName] = useState("Agent User");

  if (user) {
    return <Navigate to={user.role === "admin" ? "/admin" : "/agent"} />;
  }

  async function submitAuth(event) {
    event.preventDefault();
    setAuthError("");
    const currentUser =
      formMode === "register"
        ? await signUpEmail({ email, password, name })
        : await signInEmail({ email, password });

    if (currentUser) {
      router.navigate({ to: currentUser.role === "admin" ? "/admin" : "/agent" });
    }
  }

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-5xl items-center gap-5 px-4 py-8 sm:px-6 lg:grid-cols-[1.1fr_1fr]">
      <section className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Lease Bot</p>
        <h2 className="text-2xl font-semibold leading-tight sm:text-3xl">Modern leasing ops, focused workflow.</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Sign in to access agent and admin tools with the same auth and role routing already in place.
        </p>
      </section>

      <Card className="w-full space-y-1">
        <CardHeader>
          <div className="mb-2 flex justify-end">
            <ThemeToggle />
          </div>
          <CardTitle className="text-xl">Lease Bot Login</CardTitle>
          <CardDescription className="text-sm">
            API health: {health} · Base URL: {apiBaseUrl}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5">
            <Button
              type="button"
              variant={formMode === "login" ? "default" : "outline"}
              onClick={() => setFormMode("login")}
            >
              Login
            </Button>
            <Button
              type="button"
              variant={formMode === "register" ? "default" : "outline"}
              onClick={() => setFormMode("register")}
            >
              Register
            </Button>
          </div>

          <form onSubmit={submitAuth} className="space-y-4" aria-label="Authentication form">
            {formMode === "register" ? (
              <Label className="grid gap-1.5 text-sm">
                Name
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Label>
            ) : null}

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

            <Button type="submit" className="w-full">
              {formMode === "register" ? "Create account" : "Sign in"}
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
