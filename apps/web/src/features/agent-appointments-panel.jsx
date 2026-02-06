import { Filter } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Calendar } from "../components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { DatePicker } from "../components/ui/date-picker";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { endOfMonth, eachDayOfInterval, format, startOfMonth } from "date-fns";
import { useEffect, useMemo, useState } from "react";

const statusBadgeClass = {
  pending: "border-status-pending-border bg-status-pending text-status-pending-foreground",
  confirmed: "border-status-confirmed-border bg-status-confirmed text-status-confirmed-foreground",
  cancelled: "border-status-cancelled-border bg-status-cancelled text-status-cancelled-foreground",
  completed: "border-status-completed-border bg-status-completed text-status-completed-foreground",
};

function statusClass(status) {
  return statusBadgeClass[status] || "";
}

export function AgentAppointmentsPanel() {
  const {
    apiError,
    user,
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
      [key]: value,
    }));
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
    if (!appointmentFilters.unitId || appointmentFilters.unitId === "all") {
      return;
    }

    refreshAvailability(appointmentFilters.unitId);
  }, [appointmentFilters.unitId]);

  const unitNameById = useMemo(
    () => new Map(units.map((unit) => [unit.id, `${unit.propertyName} ${unit.unitNumber}`])),
    [units]
  );

  const calendarDateKeys = useMemo(() => {
    if (appointmentFilters.unitId !== "all" && availability.length > 0) {
      return new Set(
        availability
          .map((item) => (item.localStart || "").slice(0, 10))
          .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      );
    }

    return new Set(
      appointments
        .map((item) => (item.startsAt || "").slice(0, 10))
        .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    );
  }, [appointmentFilters.unitId, availability, appointments]);

  const monthDays = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfMonth(calendarMonth),
        end: endOfMonth(calendarMonth),
      }),
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
    if (!selectedCalendarDay) {
      return "Select a day for details.";
    }

    const selectedKey = format(selectedCalendarDay, "yyyy-MM-dd");
    return calendarDateKeys.has(selectedKey)
      ? `${selectedKey}: available`
      : `${selectedKey}: empty`;
  }, [selectedCalendarDay, calendarDateKeys]);

  const unitContext =
    appointmentFilters.unitId && appointmentFilters.unitId !== "all"
      ? unitNameById.get(appointmentFilters.unitId) || appointmentFilters.unitId
      : "All units";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">My Showings</h2>
        <Badge>{appointments.length} appointments</Badge>
      </div>

      {apiError ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"
          role="alert"
        >
          {apiError}
        </p>
      ) : null}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Label>
            Status
            <Select
              value={appointmentFilters.status}
              onChange={(event) => updateFilter("status", event.target.value)}
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancelled">Cancelled</option>
              <option value="completed">Completed</option>
            </Select>
          </Label>

          <Label className="sm:col-span-2">
            Unit
            <Select
              value={appointmentFilters.unitId}
              onChange={(event) => updateFilter("unitId", event.target.value)}
            >
              <option value="all">All units</option>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.propertyName} {unit.unitNumber}
                </option>
              ))}
            </Select>
          </Label>

          <Label>
            From
            <DatePicker
              id="appointments-from-date"
              value={appointmentFilters.fromDate}
              onChange={(value) => updateFilter("fromDate", value)}
            />
          </Label>

          <Label>
            To
            <DatePicker
              id="appointments-to-date"
              value={appointmentFilters.toDate}
              onChange={(value) => updateFilter("toDate", value)}
            />
          </Label>

          <Button
            type="button"
            variant="outline"
            className="sm:col-span-2 lg:col-span-5"
            onClick={applyFilters}
            disabled={isApplyingFilters}
          >
            <Filter className="mr-2 h-3.5 w-3.5" />
            {isApplyingFilters ? "Applying..." : "Apply filters"}
          </Button>
        </CardContent>
      </Card>

      {/* Calendar */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Availability</CardTitle>
            <span className="text-xs text-muted-foreground">{unitContext}</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
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
            className="rounded-md border border-border"
            footer={
              <span className="text-xs text-muted-foreground">
                {selectedDayStatus} &middot; {availableDays.length} available &middot;{" "}
                {emptyDays.length} empty
              </span>
            }
          />

          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1">
              <span
                className="h-2 w-2 rounded-full bg-status-confirmed-border"
                aria-hidden
              />
              Available
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1">
              <span
                className="h-2 w-2 rounded-full bg-muted-foreground/40"
                aria-hidden
              />
              Empty
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Appointments + Timeline */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Appointments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2" data-testid="agent-appointments-card-list">
            {appointments.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-border p-3"
                data-testid="agent-appointment-row"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{item.unit || item.unitId}</p>
                  <Badge className={statusClass(item.status)}>{item.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.localStart} - {item.localEnd} ({item.displayTimezone || item.timezone})
                </p>
                <p className="text-xs text-muted-foreground">
                  Lead: {item.conversation?.leadName || "Unknown"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Updated: {formatTimestamp(item.updatedAt)}
                </p>
              </div>
            ))}
            {appointments.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No appointments for selected filters.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {timelineBuckets.map((bucket) => (
              <div
                key={bucket.date}
                className="space-y-2 rounded-lg border border-border p-3"
                data-testid="agent-appointment-day"
              >
                <p className="text-sm font-semibold">{bucket.date}</p>
                {bucket.items.map((item) => (
                  <div key={item.id} className="rounded-md bg-muted/50 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {item.localStart} - {item.localEnd}
                      </span>
                      <Badge className={statusClass(item.status)}>{item.status}</Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground">{item.unit || item.unitId}</p>
                  </div>
                ))}
              </div>
            ))}
            {timelineBuckets.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Timeline empty.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
