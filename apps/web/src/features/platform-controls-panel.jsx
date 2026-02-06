import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Select } from "../components/ui/select";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { useMemo, useState } from "react";

function formatHealthTimestamp(value) {
  if (!value) {
    return "n/a";
  }
  return formatTimestamp(value);
}

export function PlatformControlsPanel() {
  const {
    platformPolicies,
    platformHealth,
    globalPlatformSendMode,
    platformHealthGeneratedAt,
    refreshAdminPlatformData,
    updatePlatformPolicy
  } = useLeaseBot();
  const [savingId, setSavingId] = useState("");

  const healthByAccountId = useMemo(
    () => new Map(platformHealth.map((item) => [item.id, item])),
    [platformHealth]
  );

  async function savePolicy(platformAccountId, updates) {
    setSavingId(platformAccountId);
    try {
      await updatePlatformPolicy(platformAccountId, updates);
    } finally {
      setSavingId("");
    }
  }

  return (
    <section>
      <Card>
        <CardHeader>
          <CardTitle>Platform controls</CardTitle>
          <CardDescription>
            Configure is_active and send_mode with policy-backed health visibility. Global default send mode: {globalPlatformSendMode}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Health snapshot: {formatHealthTimestamp(platformHealthGeneratedAt)}</p>
            <Button type="button" variant="outline" size="sm" onClick={refreshAdminPlatformData}>
              Refresh platform controls
            </Button>
          </div>

          <div className="space-y-2" data-testid="platform-controls-list">
            {platformPolicies.map((item) => {
              const health = healthByAccountId.get(item.id);
              const isSaving = savingId === item.id;
              return (
                <div key={item.id} className="space-y-2 rounded-md border border-border p-3" data-testid="platform-policy-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{item.platform}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.accountName} ({item.accountExternalId || "n/a"})
                      </p>
                    </div>
                    <Badge>{item.isActive ? "active" : "inactive"}</Badge>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant={item.isActive ? "outline" : "default"}
                      disabled={isSaving}
                      onClick={() => savePolicy(item.id, { isActive: !item.isActive })}
                    >
                      {item.isActive ? "Disable platform" : "Enable platform"}
                    </Button>
                    <Select
                      value={item.sendModeOverride || "inherit"}
                      disabled={isSaving}
                      onChange={(event) =>
                        savePolicy(item.id, {
                          sendMode: event.target.value === "inherit" ? null : event.target.value
                        })
                      }
                    >
                      <option value="inherit">inherit ({globalPlatformSendMode})</option>
                      <option value="draft_only">draft_only</option>
                      <option value="auto_send">auto_send</option>
                    </Select>
                  </div>

                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <p>Effective send mode: {health?.sendMode || item.sendMode}</p>
                    <p>Last successful ingest: {formatHealthTimestamp(health?.lastSuccessfulIngestAt)}</p>
                    <p>Last successful send: {formatHealthTimestamp(health?.lastSuccessfulSendAt)}</p>
                    <p>Error count (24h): {health?.errorCount24h ?? 0}</p>
                    <p>Disable reason: {health?.disableReason || "n/a"}</p>
                  </div>
                </div>
              );
            })}
            {platformPolicies.length === 0 ? <p className="text-sm text-muted-foreground">No platform policy accounts yet.</p> : null}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
