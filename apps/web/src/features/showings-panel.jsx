import { RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { useLeaseBot } from "../state/lease-bot-context";
import { useEffect, useMemo, useState } from "react";

const SHOWINGS_PAGE_SIZE = 12;

export function ShowingsPanel() {
  const {
    apiError,
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Showings</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefreshShowings}
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

      <div className="flex items-end gap-3">
        <Label className="flex-1">
          Unit
          <Select
            value={selectedUnitId}
            onChange={(event) => setSelectedUnitId(event.target.value)}
          >
            <option value="">Select unit</option>
            {units.map((item) => (
              <option key={item.id} value={item.id}>
                {item.propertyName} {item.unitNumber}
              </option>
            ))}
          </Select>
        </Label>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Weekly recurring rules */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Weekly recurring</CardTitle>
              <span className="text-xs text-muted-foreground">{weeklyRules.length} rules</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2" data-testid="weekly-rules-card-list">
            {weeklyRules.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No recurring rules.</p>
            ) : null}
            {pagedWeeklyRules.map((item) => (
              <div
                key={item.ruleId}
                data-testid="weekly-rule-row"
                className="rounded-lg border border-border p-3"
              >
                <p className="text-sm font-medium">Rule {item.ruleId.slice(0, 8)}</p>
                <p className="text-xs text-muted-foreground">{item.timezone}</p>
                <p className="text-xs text-muted-foreground">
                  {item.occurrences?.length || 0} occurrences
                </p>
              </div>
            ))}
            {weeklyRules.length > SHOWINGS_PAGE_SIZE ? (
              <div className="flex items-center justify-between pt-1">
                <p className="text-xs text-muted-foreground" data-testid="weekly-rules-pagination-summary">
                  Page {rulesPage} / {rulesPageCount}
                </p>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    disabled={rulesPage <= 1}
                    onClick={() => setRulesPage((current) => Math.max(1, current - 1))}
                    aria-label="Previous rules page"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    disabled={rulesPage >= rulesPageCount}
                    onClick={() => setRulesPage((current) => Math.min(rulesPageCount, current + 1))}
                    aria-label="Next rules page"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Availability slots */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Availability slots</CardTitle>
              <span className="text-xs text-muted-foreground">{availability.length} slots</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2" data-testid="availability-card-list">
            {availability.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No slots loaded.</p>
            ) : null}
            {pagedAvailability.map((item) => (
              <div
                key={item.id}
                data-testid="availability-row"
                className="rounded-lg border border-border p-3"
              >
                <p className="text-sm font-medium">{item.source}</p>
                <p className="text-xs text-muted-foreground">
                  {item.localStart} - {item.localEnd}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.displayTimezone || item.timezone}
                </p>
              </div>
            ))}
            {availability.length > SHOWINGS_PAGE_SIZE ? (
              <div className="flex items-center justify-between pt-1">
                <p className="text-xs text-muted-foreground" data-testid="availability-pagination-summary">
                  Page {availabilityPage} / {availabilityPageCount}
                </p>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    disabled={availabilityPage <= 1}
                    onClick={() =>
                      setAvailabilityPage((current) => Math.max(1, current - 1))
                    }
                    aria-label="Previous slots page"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    disabled={availabilityPage >= availabilityPageCount}
                    onClick={() =>
                      setAvailabilityPage((current) =>
                        Math.min(availabilityPageCount, current + 1)
                      )
                    }
                    aria-label="Next slots page"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
