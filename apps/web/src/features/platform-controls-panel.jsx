import { RefreshCw } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
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
    apiError,
    platformPolicies,
    platformHealth,
    globalPlatformSendMode,
    platformHealthGeneratedAt,
    refreshAdminPlatformData,
    updatePlatformPolicy,
  } = useLeaseBot();
  const [savingId, setSavingId] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  async function handleRefreshPlatformControls() {
    setIsRefreshing(true);
    try {
      await refreshAdminPlatformData();
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Platform Controls</h2>
          <p className="text-xs text-muted-foreground">
            Default send mode: <span className="font-medium">{globalPlatformSendMode}</span>
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefreshPlatformControls}
          disabled={isRefreshing}
        >
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {apiError ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"
          role="alert"
        >
          {apiError}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Health snapshot: {formatHealthTimestamp(platformHealthGeneratedAt)}
      </p>

      <div className="space-y-3" data-testid="platform-controls-list">
        {platformPolicies.map((item) => {
          const health = healthByAccountId.get(item.id);
          const isSaving = savingId === item.id;
          return (
            <Card key={item.id} data-testid="platform-policy-row">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{item.platform}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {item.accountName} ({item.accountExternalId || "n/a"})
                    </p>
                  </div>
                  <Badge variant={item.isActive ? "default" : "secondary"}>
                    {item.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                    <Label htmlFor={`platform-active-${item.id}`} className="text-sm">
                      Platform active
                    </Label>
                    <Switch
                      id={`platform-active-${item.id}`}
                      checked={item.isActive}
                      disabled={isSaving}
                      aria-label={`${item.platform} active policy`}
                      onCheckedChange={(nextChecked) =>
                        savePolicy(item.id, { isActive: nextChecked })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Send mode</Label>
                    <Select
                      value={item.sendModeOverride || "inherit"}
                      disabled={isSaving}
                      onChange={(event) =>
                        savePolicy(item.id, {
                          sendMode: event.target.value === "inherit" ? null : event.target.value,
                        })
                      }
                    >
                      <option value="inherit">Inherit ({globalPlatformSendMode})</option>
                      <option value="draft_only">Draft only</option>
                      <option value="auto_send">Auto send</option>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-x-4 gap-y-1 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                  <p>Effective mode: {health?.sendMode || item.sendMode}</p>
                  <p>Last ingest: {formatHealthTimestamp(health?.lastSuccessfulIngestAt)}</p>
                  <p>Last send: {formatHealthTimestamp(health?.lastSuccessfulSendAt)}</p>
                  <p>Errors (24h): {health?.errorCount24h ?? 0}</p>
                  {health?.disableReason ? (
                    <p className="sm:col-span-2">Reason: {health.disableReason}</p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {platformPolicies.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground" role="status">
            No platform accounts configured.
          </p>
        ) : null}
      </div>
    </div>
  );
}
