import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { useMemo } from "react";

const statusBadgeClass = {
  pending: "bg-amber-100 text-amber-900 border-amber-300",
  confirmed: "bg-emerald-100 text-emerald-900 border-emerald-300",
  cancelled: "bg-rose-100 text-rose-900 border-rose-300",
  completed: "bg-sky-100 text-sky-900 border-sky-300"
};

function statusClass(status) {
  return statusBadgeClass[status] || "";
}

export function AgentAppointmentsPanel() {
  const { units, appointments, appointmentFilters, setAppointmentFilters, refreshAppointments } = useLeaseBot();

  const timelineBuckets = useMemo(() => {
    const grouped = new Map();
    for (const item of appointments) {
      const dateKey = (item.startsAt || "").slice(0, 10) || "unscheduled";
      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, []);
      }
      grouped.get(dateKey).push(item);
    }

    return Array.from(grouped.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, items]) => ({ date, items }));
  }, [appointments]);

  function updateFilter(key, value) {
    setAppointmentFilters((current) => ({
      ...current,
      [key]: value
    }));
  }

  function applyFilters() {
    refreshAppointments(appointmentFilters);
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">My showings</h3>
        <Badge>{appointments.length} assigned</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Appointment filters</CardTitle>
          <CardDescription>Filter by date range, status, and unit</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Label>
            Status
            <Select value={appointmentFilters.status} onChange={(event) => updateFilter("status", event.target.value)}>
              <option value="all">all</option>
              <option value="pending">pending</option>
              <option value="confirmed">confirmed</option>
              <option value="cancelled">cancelled</option>
              <option value="completed">completed</option>
            </Select>
          </Label>

          <Label className="sm:col-span-2">
            Unit
            <Select value={appointmentFilters.unitId} onChange={(event) => updateFilter("unitId", event.target.value)}>
              <option value="all">all units</option>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.propertyName} {unit.unitNumber}
                </option>
              ))}
            </Select>
          </Label>

          <Label>
            From date
            <Input type="date" value={appointmentFilters.fromDate} onChange={(event) => updateFilter("fromDate", event.target.value)} />
          </Label>

          <Label>
            To date
            <Input type="date" value={appointmentFilters.toDate} onChange={(event) => updateFilter("toDate", event.target.value)} />
          </Label>

          <Button type="button" variant="outline" className="sm:col-span-2 lg:col-span-5" onClick={applyFilters}>
            Apply filters
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Assigned list</CardTitle>
            <CardDescription>Upcoming and historical showing records</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2" data-testid="agent-appointments-card-list">
            {appointments.map((item) => (
              <div key={item.id} className="space-y-1 rounded-md border border-border p-3" data-testid="agent-appointment-row">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{item.unit || item.unitId}</p>
                  <Badge className={statusClass(item.status)}>{item.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {item.localStart} - {item.localEnd} ({item.displayTimezone || item.timezone})
                </p>
                <p className="text-xs text-muted-foreground">Lead: {item.conversation?.leadName || "Unknown"}</p>
                <p className="text-xs text-muted-foreground">Updated: {formatTimestamp(item.updatedAt)}</p>
              </div>
            ))}
            {appointments.length === 0 ? <p className="text-sm text-muted-foreground">No appointments for selected filters.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
            <CardDescription>Grouped by day for fast daily planning</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {timelineBuckets.map((bucket) => (
              <div key={bucket.date} className="space-y-2 rounded-md border border-border p-3" data-testid="agent-appointment-day">
                <p className="text-sm font-semibold">{bucket.date}</p>
                {bucket.items.map((item) => (
                  <div key={item.id} className="rounded-md bg-muted p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span>{item.localStart} - {item.localEnd}</span>
                      <Badge className={statusClass(item.status)}>{item.status}</Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground">{item.unit || item.unitId}</p>
                  </div>
                ))}
              </div>
            ))}
            {timelineBuckets.length === 0 ? <p className="text-sm text-muted-foreground">Timeline empty.</p> : null}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
