import { Navigate, createRoute, useRouter } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useLeaseBot } from "../state/lease-bot-context";
import { rootRoute } from "./root-route";
import { useState } from "react";

function LoginPage() {
  const router = useRouter();
  const { user, health, apiBaseUrl, authError, setAuthError, signInEmail, signUpEmail } = useLeaseBot();
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
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-3 py-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">Lease Bot Login</CardTitle>
          <CardDescription>
            API health: {health} · Base URL: {apiBaseUrl}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
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

          <form onSubmit={submitAuth} className="space-y-3">
            {formMode === "register" ? (
              <Label>
                Name
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Label>
            ) : null}

            <Label>
              Email
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </Label>

            <Label>
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
          {authError ? <p className="text-sm text-red-700">{authError}</p> : null}
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
