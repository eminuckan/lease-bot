import { createRoute, Navigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ThemeToggle } from "../components/theme-toggle";
import { useLeaseBot } from "../state/lease-bot-context";
import { rootRoute } from "./root-route";

function InvitePage() {
  const router = useRouter();
  const { user, verifyInvitationToken, acceptInvitationToken } = useLeaseBot();
  const token = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return new URLSearchParams(window.location.search).get("token") || "";
  }, []);

  const [loading, setLoading] = useState(true);
  const [verifyingError, setVerifyingError] = useState("");
  const [invitation, setInvitation] = useState(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;

    async function verify() {
      if (!token) {
        setVerifyingError("Invite token is missing.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setVerifyingError("");
      try {
        const response = await verifyInvitationToken(token);
        if (!active) {
          return;
        }
        setInvitation(response.invitation || null);
      } catch (error) {
        if (!active) {
          return;
        }
        setVerifyingError(error.message || "Invite is invalid or expired.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    verify();
    return () => {
      active = false;
    };
  }, [token, verifyInvitationToken]);

  if (user) {
    return <Navigate to={user.role === "admin" ? "/admin" : "/agent"} />;
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setSubmitError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    try {
      await acceptInvitationToken({ token, password });
      router.navigate({ to: "/login" });
    } catch (error) {
      setSubmitError(error.message || "Invite acceptance failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8 sm:px-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex justify-end">
            <ThemeToggle />
          </div>
          <CardTitle className="text-xl">Set your account password</CardTitle>
          <CardDescription className="text-sm">
            Accept invite and finish account setup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? <p className="text-sm text-muted-foreground">Verifying invitation...</p> : null}

          {!loading && verifyingError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive-text">
              {verifyingError}
            </div>
          ) : null}

          {!loading && invitation ? (
            <form onSubmit={submit} className="space-y-4">
              <div className="rounded-md border border-dashed border-border p-3 text-sm">
                <p><span className="text-muted-foreground">Email:</span> {invitation.email}</p>
                <p><span className="text-muted-foreground">Name:</span> {invitation.firstName} {invitation.lastName}</p>
                <p><span className="text-muted-foreground">Role:</span> {invitation.role}</p>
              </div>

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

              <Label className="grid gap-1.5 text-sm">
                Confirm password
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  minLength={8}
                  required
                />
              </Label>

              {submitError ? <p className="text-xs text-destructive-text">{submitError}</p> : null}

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Creating account..." : "Create account"}
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

export const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite",
  component: InvitePage
});
