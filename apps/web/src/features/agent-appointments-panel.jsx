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
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Plus,
  RefreshCw,
  Trash2,
  UserRound
} from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { cn } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";

const DAY_OPTIONS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" }
];

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

function availabilityTone(status) {
  if (status === "available") {
    return "bg-emerald-500/15 text-emerald-300";
  }
  if (status === "unavailable") {
    return "bg-destructive/15 text-destructive-text";
  }
  return "bg-muted text-muted-foreground";
}

export function AgentAppointmentsPanel() {
  const {
    user,
    isAdmin,
    agents,
    appointments,
    agentAvailability,
    agentWeeklyRules,
    refreshAppointments,
    refreshAgentAvailability,
    refreshAgentWeeklyRules,
    createAgentWeeklyRule,
    deleteAgentWeeklyRule,
  } = useLeaseBot();

  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingRule, setIsSavingRule] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    dayOfWeek: "2",
    startTime: "19:00",
    endTime: "20:00",
    weeks: "8",
    status: "available",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
  });

  useEffect(() => {
    if (!user) {
      setSelectedAgentId("");
      return;
    }

    if (user.role === "agent") {
      setSelectedAgentId(user.id);
      return;
    }

    if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0].id);
    }
  }, [user, agents, selectedAgentId]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || null,
    [agents, selectedAgentId]
  );

  useEffect(() => {
    if (!selectedAgent?.timezone) {
      return;
    }

    setRuleForm((current) => ({
      ...current,
      timezone: selectedAgent.timezone
    }));
  }, [selectedAgent?.timezone]);

  async function loadAgentCalendar() {
    const rangeStart = startOfWeek(startOfMonth(calendarMonth), { weekStartsOn: 0 });
    const rangeEnd = endOfWeek(endOfMonth(calendarMonth), { weekStartsOn: 0 });
    const fromDate = format(rangeStart, "yyyy-MM-dd");
    const toDate = format(rangeEnd, "yyyy-MM-dd");

    setIsRefreshing(true);
    try {
      await Promise.all([
        refreshAppointments({
          status: "all",
          agentId: selectedAgentId || "all",
          unitId: "all",
          fromDate,
          toDate
        }),
        refreshAgentAvailability(selectedAgentId, {
          fromDate,
          toDate,
          timezone: ruleForm.timezone
        }),
        refreshAgentWeeklyRules(selectedAgentId)
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    void loadAgentCalendar();
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

  const availabilityItemsByDay = useMemo(() => {
    const map = new Map();
    for (const item of agentAvailability) {
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
  }, [agentAvailability]);

  const selectedDayAppointments = useMemo(() => {
    return appointmentItemsByDay.get(dateKey(selectedDate)) || [];
  }, [appointmentItemsByDay, selectedDate]);

  const selectedDayAvailability = useMemo(() => {
    return availabilityItemsByDay.get(dateKey(selectedDate)) || [];
  }, [availabilityItemsByDay, selectedDate]);

  async function handleCreateRule(event) {
    event.preventDefault();
    if (!selectedAgentId) {
      return;
    }

    setIsSavingRule(true);
    try {
      await createAgentWeeklyRule(selectedAgentId, {
        dayOfWeek: Number(ruleForm.dayOfWeek),
        startTime: ruleForm.startTime,
        endTime: ruleForm.endTime,
        timezone: ruleForm.timezone,
        weeks: Number(ruleForm.weeks || 8),
        status: ruleForm.status,
        fromDate: format(new Date(), "yyyy-MM-dd")
      });
      await loadAgentCalendar();
    } finally {
      setIsSavingRule(false);
    }
  }

  async function handleDeleteRule(ruleId) {
    if (!selectedAgentId || !ruleId) {
      return;
    }

    await deleteAgentWeeklyRule(selectedAgentId, ruleId);
    await loadAgentCalendar();
  }

  return (
    <div className="px-4 py-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <CalendarClock className="h-4 w-4" />
          <span>My showings calendar</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{appointments.length} appointments</span>
        </div>

        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          {isAdmin ? (
            <Select value={selectedAgentId || "all"} onValueChange={(value) => setSelectedAgentId(value === "all" ? "" : value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
              <UserRound className="h-4 w-4 text-muted-foreground" />
              <span>{selectedAgent?.fullName || user?.email || "Agent"}</span>
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            className="justify-center"
            onClick={() => void loadAgentCalendar()}
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
                const dayAvailability = availabilityItemsByDay.get(key) || [];
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
                      <span className="text-[10px] text-muted-foreground">
                        {dayAppointments.length}/{dayAvailability.length}
                      </span>
                    </div>
                    <div className="mt-1 space-y-1">
                      {dayAppointments.slice(0, 1).map((item) => (
                        <div key={item.id} className="truncate rounded bg-muted/70 px-1.5 py-0.5 text-[10px]">
                          appt {format(safeDate(item.startsAt) || new Date(), "HH:mm")}
                        </div>
                      ))}
                      {dayAvailability.slice(0, 1).map((item) => (
                        <div key={item.id} className="truncate rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                          free {format(safeDate(item.startsAt) || new Date(), "HH:mm")}
                        </div>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-3">
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-sm font-semibold">{format(selectedDate, "EEE, MMM d")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Appointments and availability for selected day.</p>

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

                {selectedDayAvailability.map((item) => (
                  <div key={`slot-${item.id}`} className="rounded-md border border-border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium">Availability slot</p>
                      <Badge className={availabilityTone(item.status)}>{item.status}</Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock3 className="h-3 w-3" />
                      <span>{item.localStart} - {item.localEnd}</span>
                    </div>
                  </div>
                ))}

                {selectedDayAppointments.length === 0 && selectedDayAvailability.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    No entries for selected day.
                  </div>
                ) : null}
              </div>
            </div>

            <form onSubmit={handleCreateRule} className="rounded-md border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">Weekly availability</p>
                <Badge variant="outline">recurring</Badge>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Day</Label>
                  <Select value={ruleForm.dayOfWeek} onValueChange={(value) => setRuleForm((current) => ({ ...current, dayOfWeek: value }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Weeks</Label>
                  <Input
                    type="number"
                    min="1"
                    max="26"
                    value={ruleForm.weeks}
                    onChange={(event) => setRuleForm((current) => ({ ...current, weeks: event.target.value }))}
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Start</Label>
                  <Input
                    type="time"
                    value={ruleForm.startTime}
                    onChange={(event) => setRuleForm((current) => ({ ...current, startTime: event.target.value }))}
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">End</Label>
                  <Input
                    type="time"
                    value={ruleForm.endTime}
                    onChange={(event) => setRuleForm((current) => ({ ...current, endTime: event.target.value }))}
                  />
                </div>

                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Timezone</Label>
                  <Input
                    value={ruleForm.timezone}
                    onChange={(event) => setRuleForm((current) => ({ ...current, timezone: event.target.value }))}
                    placeholder="America/New_York"
                  />
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                <Select value={ruleForm.status} onValueChange={(value) => setRuleForm((current) => ({ ...current, status: value }))}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available">Available</SelectItem>
                    <SelectItem value="unavailable">Unavailable</SelectItem>
                  </SelectContent>
                </Select>

                <Button type="submit" size="sm" disabled={!selectedAgentId || isSavingRule}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  {isSavingRule ? "Saving..." : "Add recurring"}
                </Button>
              </div>
            </form>

            <div className="rounded-md border border-border bg-card p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recurring rules</p>
              <div className="space-y-2">
                {agentWeeklyRules.map((rule) => {
                  const first = Array.isArray(rule.occurrences) && rule.occurrences.length > 0 ? rule.occurrences[0] : null;
                  return (
                    <div key={rule.ruleId} className="rounded-md border border-border px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium">{rule.status} · {rule.timezone}</p>
                          <p className="text-[11px] text-muted-foreground">{rule.occurrences?.length || 0} occurrences</p>
                          {first ? (
                            <p className="text-[11px] text-muted-foreground">first: {first.localStart} - {first.localEnd}</p>
                          ) : null}
                        </div>
                        <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => void handleDeleteRule(rule.ruleId)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {agentWeeklyRules.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recurring rules yet.</p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
