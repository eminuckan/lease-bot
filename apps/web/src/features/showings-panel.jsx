import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { useLeaseBot } from "../state/lease-bot-context";
import { useEffect, useMemo, useState } from "react";

const SHOWINGS_PAGE_SIZE = 12;

export function ShowingsPanel() {
  const { units, selectedUnitId, setSelectedUnitId, weeklyRules, availability, refreshAvailability } = useLeaseBot();
  const [rulesPage, setRulesPage] = useState(1);
  const [availabilityPage, setAvailabilityPage] = useState(1);

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

  return (
    <section>
      <Card>
        <CardHeader>
          <CardTitle>Showings</CardTitle>
          <CardDescription>Recurring rules and per-day slots shown as stacked cards</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label>
            Unit
            <Select value={selectedUnitId} onChange={(event) => setSelectedUnitId(event.target.value)}>
              <option value="">Select unit</option>
              {units.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.propertyName} {item.unitNumber}
                </option>
              ))}
            </Select>
          </Label>
          <Button type="button" variant="outline" className="w-full" onClick={() => refreshAvailability(selectedUnitId)}>
            Refresh showings
          </Button>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-2" data-testid="weekly-rules-card-list">
              <h4 className="text-sm font-semibold">Weekly recurring</h4>
              {weeklyRules.length === 0 ? <p className="text-sm text-muted-foreground">No recurring rules.</p> : null}
              {pagedWeeklyRules.map((item) => (
                <div key={item.ruleId} data-testid="weekly-rule-row" className="rounded-md border border-border p-3">
                  <p className="text-sm font-medium">Rule {item.ruleId.slice(0, 8)}</p>
                  <p className="text-xs text-muted-foreground">{item.timezone}</p>
                  <p className="text-xs text-muted-foreground">Occurrences: {item.occurrences?.length || 0}</p>
                </div>
              ))}
              {weeklyRules.length > 0 ? (
                <div className="space-y-2 rounded-md border border-border p-2">
                  <p className="text-xs text-muted-foreground" data-testid="weekly-rules-pagination-summary">
                    Showing {pagedWeeklyRules.length} of {weeklyRules.length} rules (page {rulesPage} of {rulesPageCount})
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rulesPage <= 1}
                      onClick={() => setRulesPage((current) => Math.max(1, current - 1))}
                    >
                      Prev rules
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rulesPage >= rulesPageCount}
                      onClick={() => setRulesPage((current) => Math.min(rulesPageCount, current + 1))}
                    >
                      Next rules
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="space-y-2" data-testid="availability-card-list">
              <h4 className="text-sm font-semibold">Availability slots</h4>
              {availability.length === 0 ? <p className="text-sm text-muted-foreground">No slots loaded.</p> : null}
              {pagedAvailability.map((item) => (
                <div key={item.id} data-testid="availability-row" className="rounded-md border border-border p-3">
                  <p className="text-sm font-medium">{item.source}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.localStart} - {item.localEnd}
                  </p>
                  <p className="text-xs text-muted-foreground">TZ: {item.displayTimezone || item.timezone}</p>
                </div>
              ))}
              {availability.length > 0 ? (
                <div className="space-y-2 rounded-md border border-border p-2">
                  <p className="text-xs text-muted-foreground" data-testid="availability-pagination-summary">
                    Showing {pagedAvailability.length} of {availability.length} slots (page {availabilityPage} of {availabilityPageCount})
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={availabilityPage <= 1}
                      onClick={() => setAvailabilityPage((current) => Math.max(1, current - 1))}
                    >
                      Prev slots
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={availabilityPage >= availabilityPageCount}
                      onClick={() => setAvailabilityPage((current) => Math.min(availabilityPageCount, current + 1))}
                    >
                      Next slots
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
