import { RefreshCw, ChevronLeft, ChevronRight, Clock, Repeat } from "lucide-react";
import { Label } from "../components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { useLeaseBot } from "../state/lease-bot-context";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";

const SHOWINGS_PAGE_SIZE = 12;

export function ShowingsPanel() {
  const {
    units,
    selectedUnitId,
    setSelectedUnitId,
    weeklyRules,
    availability,
    refreshAvailability,
  } = useLeaseBot();
  const [rulesPage, setRulesPage] = useState(1);
  const [availabilityPage, setAvailabilityPage] = useState(1);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const rulesPageCount = Math.max(1, Math.ceil(weeklyRules.length / SHOWINGS_PAGE_SIZE));
  const availabilityPageCount = Math.max(1, Math.ceil(availability.length / SHOWINGS_PAGE_SIZE));
  const pagedWeeklyRules = useMemo(() => {
    const start = (rulesPage - 1) * SHOWINGS_PAGE_SIZE;
    return weeklyRules.slice(start, start + SHOWINGS_PAGE_SIZE);
  }, [weeklyRules, rulesPage]);
  const pagedAvailability = useMemo(() => {
    const start = (availabilityPage - 1) * SHOWINGS_PAGE_SIZE;
    return availability.slice(start, start + SHOWINGS_PAGE_SIZE);
  }, [availability, availabilityPage]);

  useEffect(() => {
    setRulesPage(1);
  }, [selectedUnitId, weeklyRules.length]);

  useEffect(() => {
    setAvailabilityPage(1);
  }, [selectedUnitId, availability.length]);

  async function handleRefreshShowings() {
    setIsRefreshing(true);
    try {
      await refreshAvailability(selectedUnitId);
    } finally {
      setIsRefreshing(false);
    }
  }

  function PaginationControls({ page, pageCount, setPage, testId }) {
    if (pageCount <= 1) return null;
    return (
      <div className="flex items-center justify-between px-4 py-2.5" data-testid={testId}>
        <span className="text-xs text-muted-foreground">{page} / {pageCount}</span>
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
            disabled={page <= 1}
            onClick={() => setPage((c) => Math.max(1, c - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
            disabled={page >= pageCount}
            onClick={() => setPage((c) => Math.min(pageCount, c + 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Unit selector + refresh */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">Unit</Label>
            <Select
              value={selectedUnitId || "__none__"}
              onValueChange={(v) => setSelectedUnitId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger className="mt-1.5 h-10 text-sm">
                <SelectValue placeholder="Select unit" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select unit</SelectItem>
                {units.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.propertyName} {item.unitNumber}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleRefreshShowings}
              disabled={isRefreshing}
              className="mb-px rounded-md bg-muted p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </button>
          </div>
        </div>

        {/* Two-column layout */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Weekly recurring rules */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Repeat className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Weekly rules</h3>
              </div>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{weeklyRules.length}</span>
            </div>
            <div className="rounded-lg bg-card shadow-card" data-testid="weekly-rules-card-list">
              {weeklyRules.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No recurring rules
                </div>
              ) : (
                <div className="space-y-1 p-2">
                  {pagedWeeklyRules.map((item) => (
                    <div
                      key={item.ruleId}
                      data-testid="weekly-rule-row"
                      className="rounded-md bg-muted px-4 py-3"
                    >
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <span className="font-mono text-xs text-muted-foreground">{item.ruleId.slice(0, 8)}</span>
                        <span className="text-xs text-muted-foreground">{item.timezone}</span>
                      </div>
                      <p className="mt-1 text-sm">
                        {item.occurrences?.length || 0} occurrences
                      </p>
                    </div>
                  ))}
                </div>
              )}
              <PaginationControls
                page={rulesPage}
                pageCount={rulesPageCount}
                setPage={setRulesPage}
                testId="weekly-rules-pagination-summary"
              />
            </div>
          </div>

          {/* Availability slots */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Availability</h3>
              </div>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{availability.length}</span>
            </div>
            <div className="rounded-lg bg-card shadow-card" data-testid="availability-card-list">
              {availability.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No slots loaded
                </div>
              ) : (
                <div className="space-y-1 p-2">
                  {pagedAvailability.map((item) => (
                    <div
                      key={item.id}
                      data-testid="availability-row"
                      className="rounded-md bg-muted px-4 py-3"
                    >
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <span className="text-sm font-medium">{item.source}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.displayTimezone || item.timezone}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.localStart} &mdash; {item.localEnd}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              <PaginationControls
                page={availabilityPage}
                pageCount={availabilityPageCount}
                setPage={setAvailabilityPage}
                testId="availability-pagination-summary"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
