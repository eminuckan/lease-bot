import { Filter, CalendarDays, Clock, MapPin, User } from "lucide-react";
import { Button } from "../components/ui/button";
import { Calendar } from "../components/ui/calendar";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { endOfMonth, eachDayOfInterval, format, startOfMonth } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";

const statusColors = {
  pending: "bg-status-pending text-status-pending-foreground border-status-pending-border",
  confirmed: "bg-status-confirmed text-status-confirmed-foreground border-status-confirmed-border",
  cancelled: "bg-status-cancelled text-status-cancelled-foreground border-status-cancelled-border",
  completed: "bg-status-completed text-status-completed-foreground border-status-completed-border",
};

function StatusPill({ status }) {
  return (
    <span className={cn(
      "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize",
      statusColors[status] || "bg-muted text-muted-foreground"
    )}>
      {status}
    </span>
  );
}

export function AgentAppointmentsPanel() {
  const {
    units,
    availability,
    appointments,
    appointmentFilters,
    setAppointmentFilters,
    refreshAvailability,
    refreshAppointments,
  } = useLeaseBot();
  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  const [selectedCalendarDay, setSelectedCalendarDay] = useState();
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);

  const timelineBuckets = useMemo(() => {
    const grouped = new Map();
    for (const item of appointments) {
      const dateKey = (item.startsAt || "").slice(0, 10) || "unscheduled";
      if (!grouped.has(dateKey)) grouped.set(dateKey, []);
      grouped.get(dateKey).push(item);
    }
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, items }));
  }, [appointments]);

  function updateFilter(key, value) {
    setAppointmentFilters((c) => ({ ...c, [key]: value }));
  }

  async function applyFilters() {
    setIsApplyingFilters(true);
    try {
      await refreshAppointments(appointmentFilters);
    } finally {
      setIsApplyingFilters(false);
    }
  }

  useEffect(() => {
    if (!appointmentFilters.unitId || appointmentFilters.unitId === "all") return;
    refreshAvailability(appointmentFilters.unitId);
  }, [appointmentFilters.unitId]);

  const unitNameById = useMemo(
    () => new Map(units.map((u) => [u.id, `${u.propertyName} ${u.unitNumber}`])),
    [units]
  );

  const calendarDateKeys = useMemo(() => {
    if (appointmentFilters.unitId !== "all" && availability.length > 0) {
      return new Set(
        availability
          .map((item) => (item.localStart || "").slice(0, 10))
          .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))
      );
    }
    return new Set(
      appointments
        .map((item) => (item.startsAt || "").slice(0, 10))
        .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))
    );
  }, [appointmentFilters.unitId, availability, appointments]);

  const monthDays = useMemo(
    () => eachDayOfInterval({ start: startOfMonth(calendarMonth), end: endOfMonth(calendarMonth) }),
    [calendarMonth]
  );

  const availableDays = useMemo(
    () => monthDays.filter((day) => calendarDateKeys.has(format(day, "yyyy-MM-dd"))),
    [monthDays, calendarDateKeys]
  );

  const emptyDays = useMemo(
    () => monthDays.filter((day) => !calendarDateKeys.has(format(day, "yyyy-MM-dd"))),
    [monthDays, calendarDateKeys]
  );

  const selectedDayStatus = useMemo(() => {
    if (!selectedCalendarDay) return null;
    const key = format(selectedCalendarDay, "yyyy-MM-dd");
    return calendarDateKeys.has(key) ? `${key}: available` : `${key}: empty`;
  }, [selectedCalendarDay, calendarDateKeys]);

  const unitContext =
    appointmentFilters.unitId && appointmentFilters.unitId !== "all"
      ? unitNameById.get(appointmentFilters.unitId) || appointmentFilters.unitId
      : "All units";

  return (
    <div className="p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Filters bar */}
        <div className="rounded-xl border border-border bg-card">
          <div className="grid items-end gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select
                value={appointmentFilters.status}
                onChange={(e) => updateFilter("status", e.target.value)}
                className="mt-1 h-9 text-sm"
              >
                <option value="all">All</option>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="cancelled">Cancelled</option>
                <option value="completed">Completed</option>
              </Select>
            </div>
            <div className="sm:col-span-2 lg:col-span-2">
              <Label className="text-xs text-muted-foreground">Unit</Label>
              <Select
                value={appointmentFilters.unitId}
                onChange={(e) => updateFilter("unitId", e.target.value)}
                className="mt-1 h-9 text-sm"
              >
                <option value="all">All units</option>
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.propertyName} {unit.unitNumber}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">From</Label>
              <input
                type="date"
                value={appointmentFilters.fromDate || ""}
                onChange={(e) => updateFilter("fromDate", e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">To</Label>
              <input
                type="date"
                value={appointmentFilters.toDate || ""}
                onChange={(e) => updateFilter("toDate", e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="border-t border-border px-5 py-3">
            <Button
              type="button"
              size="sm"
              onClick={applyFilters}
              disabled={isApplyingFilters}
            >
              <Filter className="mr-2 h-3.5 w-3.5" />
              {isApplyingFilters ? "Applying..." : "Apply filters"}
            </Button>
          </div>
        </div>

        {/* Calendar + Appointments side by side */}
        <div className="grid gap-6 lg:grid-cols-[1fr_1.5fr]">
          {/* Calendar */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Availability</h3>
              </div>
              <span className="text-xs text-muted-foreground">{unitContext}</span>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <Calendar
                mode="single"
                month={calendarMonth}
                onMonthChange={setCalendarMonth}
                selected={selectedCalendarDay}
                onSelect={setSelectedCalendarDay}
                fixedWeeks
                modifiers={{ available: availableDays, empty: emptyDays }}
                modifiersClassNames={{
                  available: "rdp-day_available",
                  empty: "rdp-day_empty",
                }}
                footer={
                  <span className="text-xs text-muted-foreground">
                    {selectedDayStatus || "Select a day"} &middot; {availableDays.length} available &middot; {emptyDays.length} empty
                  </span>
                }
              />
              <div className="mt-3 flex gap-4 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-status-confirmed-border" />
                  Available
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
                  Empty
                </span>
              </div>
            </div>
          </div>

          {/* Appointments list */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Appointments</h3>
              <span className="text-xs tabular-nums text-muted-foreground">{appointments.length}</span>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card" data-testid="agent-appointments-card-list">
              {appointments.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No appointments for selected filters.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {appointments.map((item) => (
                    <div key={item.id} className="px-5 py-3.5" data-testid="agent-appointment-row">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm font-medium">
                              {item.unit || item.unitId}
                            </span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {item.localStart} &mdash; {item.localEnd}
                            </span>
                            <span>{item.displayTimezone || item.timezone}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-4 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <User className="h-3 w-3" />
                              {item.conversation?.leadName || "Unknown"}
                            </span>
                            <span>{formatTimestamp(item.updatedAt)}</span>
                          </div>
                        </div>
                        <StatusPill status={item.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Timeline */}
        {timelineBuckets.length > 0 ? (
          <div>
            <h3 className="mb-3 text-sm font-semibold">Timeline</h3>
            <div className="space-y-2" data-testid="agent-appointments-timeline">
              {timelineBuckets.map((bucket) => (
                <div key={bucket.date} data-testid="agent-appointment-day">
                  <div className="mb-1.5 flex items-center gap-2">
                    <div className="h-px flex-1 bg-border" />
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">{bucket.date}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {bucket.items.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-lg border border-border bg-card px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium tabular-nums">
                            {item.localStart} &mdash; {item.localEnd}
                          </span>
                          <StatusPill status={item.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{item.unit || item.unitId}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
