import { RefreshCw, Zap, AlertTriangle } from "lucide-react";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { useMemo, useState } from "react";
import { cn } from "../lib/utils";

function formatHealthTimestamp(value) {
  if (!value) return "n/a";
  return formatTimestamp(value);
}

export function PlatformControlsPanel() {
  const {
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
    <div className="p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Default mode: <span className="font-medium text-foreground">{globalPlatformSendMode}</span></span>
              <span>&middot;</span>
              <span>Last snapshot: {formatHealthTimestamp(platformHealthGeneratedAt)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRefreshPlatformControls}
            disabled={isRefreshing}
            className="rounded-lg border border-border p-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          </button>
        </div>

        {/* Platform accounts */}
        <div className="space-y-3" data-testid="platform-controls-list">
          {platformPolicies.length === 0 ? (
            <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
              No platform accounts configured.
            </div>
          ) : null}

          {platformPolicies.map((item) => {
            const health = healthByAccountId.get(item.id);
            const isSaving = savingId === item.id;
            const hasErrors = (health?.errorCount24h ?? 0) > 0;

            return (
              <div
                key={item.id}
                data-testid="platform-policy-row"
                className="overflow-hidden rounded-xl border border-border bg-card"
              >
                {/* Account header */}
                <div className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-lg",
                      item.isActive ? "bg-primary/10" : "bg-muted"
                    )}>
                      <Zap className={cn(
                        "h-4 w-4",
                        item.isActive ? "text-primary" : "text-muted-foreground"
                      )} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{item.platform}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.accountName}{item.accountExternalId ? ` (${item.accountExternalId})` : ""}
                      </p>
                    </div>
                  </div>
                  <div className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-medium",
                    item.isActive
                      ? "bg-status-confirmed text-status-confirmed-foreground"
                      : "bg-muted text-muted-foreground"
                  )}>
                    {item.isActive ? "Active" : "Inactive"}
                  </div>
                </div>

                {/* Controls */}
                <div className="border-t border-border">
                  <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                    <div className="flex items-center justify-between px-5 py-3">
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
                    <div className="flex items-center gap-3 px-5 py-3">
                      <Label className="shrink-0 text-sm">Send mode</Label>
                      <Select
                        value={item.sendModeOverride || "inherit"}
                        disabled={isSaving}
                        onChange={(e) =>
                          savePolicy(item.id, {
                            sendMode: e.target.value === "inherit" ? null : e.target.value,
                          })
                        }
                        className="h-9 text-sm"
                      >
                        <option value="inherit">Inherit ({globalPlatformSendMode})</option>
                        <option value="draft_only">Draft only</option>
                        <option value="auto_send">Auto send</option>
                      </Select>
                    </div>
                  </div>
                </div>

                {/* Health stats */}
                <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
                  <div className="bg-card px-4 py-2.5">
                    <p className="text-[11px] text-muted-foreground">Effective mode</p>
                    <p className="text-xs font-medium">{health?.sendMode || item.sendMode}</p>
                  </div>
                  <div className="bg-card px-4 py-2.5">
                    <p className="text-[11px] text-muted-foreground">Last ingest</p>
                    <p className="text-xs font-medium">{formatHealthTimestamp(health?.lastSuccessfulIngestAt)}</p>
                  </div>
                  <div className="bg-card px-4 py-2.5">
                    <p className="text-[11px] text-muted-foreground">Last send</p>
                    <p className="text-xs font-medium">{formatHealthTimestamp(health?.lastSuccessfulSendAt)}</p>
                  </div>
                  <div className={cn("bg-card px-4 py-2.5", hasErrors && "bg-destructive/5")}>
                    <p className="text-[11px] text-muted-foreground">Errors (24h)</p>
                    <p className={cn("text-xs font-medium", hasErrors && "text-destructive-text")}>
                      {hasErrors ? (
                        <span className="flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {health.errorCount24h}
                        </span>
                      ) : (
                        "0"
                      )}
                    </p>
                  </div>
                </div>

                {health?.disableReason ? (
                  <div className="border-t border-border bg-destructive/5 px-5 py-2.5 text-xs text-destructive-text">
                    {health.disableReason}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
