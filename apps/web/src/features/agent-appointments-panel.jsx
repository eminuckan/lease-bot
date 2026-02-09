import { useEffect, useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  startOfMonth,
  startOfWeek,
  subMonths
} from "date-fns";
import { CalendarClock, ChevronLeft, ChevronRight, Clock3, RefreshCw, UserRound } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";

function safeDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function dateKey(date) {
  return format(date, "yyyy-MM-dd");
}

function appointmentStatusTone(status) {
  if (status === "confirmed") return "bg-emerald-500/15 text-emerald-300";
  if (status === "pending") return "bg-amber-500/15 text-amber-200";
  if (status === "reschedule_requested") return "bg-sky-500/15 text-sky-300";
  if (status === "completed") return "bg-violet-500/15 text-violet-300";
  if (status === "no_show") return "bg-orange-500/15 text-orange-200";
  if (status === "cancelled") return "bg-destructive/15 text-destructive-text";
  return "bg-muted text-muted-foreground";
}

export function AgentAppointmentsPanel() {
  const {
    user,
    appointments,
    refreshAppointments
  } = useLeaseBot();

  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);

  const selectedAgentId = user?.role === "agent" ? user.id : "";

  async function loadAppointments() {
    if (!selectedAgentId) {
      return;
    }

    const rangeStart = startOfWeek(startOfMonth(calendarMonth), { weekStartsOn: 0 });
    const rangeEnd = endOfWeek(endOfMonth(calendarMonth), { weekStartsOn: 0 });
    const fromDate = format(rangeStart, "yyyy-MM-dd");
    const toDate = format(rangeEnd, "yyyy-MM-dd");

    setIsRefreshing(true);
    try {
      await refreshAppointments({
        status: "all",
        agentId: selectedAgentId,
        unitId: "all",
        fromDate,
        toDate
      });
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    void loadAppointments();
  }, [selectedAgentId, calendarMonth]);

  const monthDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(calendarMonth), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(calendarMonth), { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [calendarMonth]);

  const appointmentItemsByDay = useMemo(() => {
    const map = new Map();
    for (const item of appointments) {
      const startsAt = safeDate(item.startsAt);
      if (!startsAt) continue;
      const key = dateKey(startsAt);
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(item);
    }

    for (const entries of map.values()) {
      entries.sort((left, right) => {
        const leftTs = safeDate(left.startsAt)?.getTime() || 0;
        const rightTs = safeDate(right.startsAt)?.getTime() || 0;
        return leftTs - rightTs;
      });
    }

    return map;
  }, [appointments]);

  const selectedDayAppointments = useMemo(() => (
    appointmentItemsByDay.get(dateKey(selectedDate)) || []
  ), [appointmentItemsByDay, selectedDate]);

  return (
    <div className="px-4 py-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <CalendarClock className="h-4 w-4" />
          <span>My showings</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
            {appointments.length} appointments
          </span>
        </div>

        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
            <UserRound className="h-4 w-4 text-muted-foreground" />
            <span>{user?.fullName || user?.email || "Agent"}</span>
          </div>

          <Button
            type="button"
            variant="secondary"
            className="justify-center"
            onClick={() => void loadAppointments()}
            disabled={isRefreshing || !selectedAgentId}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", isRefreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>

        <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <section className="rounded-md border border-border bg-card p-3">
            <div className="mb-3 flex items-center justify-between">
              <Button type="button" variant="ghost" size="icon" onClick={() => setCalendarMonth((value) => subMonths(value, 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <p className="text-sm font-semibold">{format(calendarMonth, "MMMM yyyy")}</p>
              <Button type="button" variant="ghost" size="icon" onClick={() => setCalendarMonth((value) => addMonths(value, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-7 gap-1 px-1 pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <div key={day}>{day}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {monthDays.map((day) => {
                const key = dateKey(day);
                const dayAppointments = appointmentItemsByDay.get(key) || [];
                const isSelected = isSameDay(day, selectedDate);
                const inMonth = day.getMonth() === calendarMonth.getMonth();

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedDate(day)}
                    className={cn(
                      "min-h-[92px] rounded-md border border-border p-2 text-left transition",
                      isSelected && "border-primary bg-primary/10",
                      !isSelected && "hover:bg-muted/40",
                      !inMonth && "opacity-50"
                    )}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{format(day, "d")}</span>
                      <span className="text-[10px] text-muted-foreground">{dayAppointments.length}</span>
                    </div>
                    <div className="mt-1 space-y-1">
                      {dayAppointments.slice(0, 2).map((item) => (
                        <div key={item.id} className="truncate rounded bg-muted/70 px-1.5 py-0.5 text-[10px]">
                          {format(safeDate(item.startsAt) || new Date(), "HH:mm")} {item.conversation?.leadName || "Showing"}
                        </div>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-md border border-border bg-card p-3">
            <p className="text-sm font-semibold">{format(selectedDate, "EEE, MMM d")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Appointments for selected day.</p>

            <div className="mt-3 space-y-2">
              {selectedDayAppointments.map((item) => (
                <div key={item.id} className="rounded-md border border-border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium">{item.conversation?.leadName || item.unit || "Showing"}</p>
                    <Badge className={appointmentStatusTone(item.status)}>{item.status}</Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock3 className="h-3 w-3" />
                    <span>{item.localStart} - {item.localEnd}</span>
                  </div>
                </div>
              ))}

              {selectedDayAppointments.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  No appointments for selected day.
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
