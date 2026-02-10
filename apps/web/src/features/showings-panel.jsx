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
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, ListFilter, RefreshCw } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { cn } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";

const SHOWING_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "reschedule_requested", label: "Reschedule" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No show" }
];

function safeDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function dayKeyFromDate(date) {
  return format(date, "yyyy-MM-dd");
}

function statusTone(status) {
  if (status === "confirmed") return "bg-emerald-500/15 text-emerald-300";
  if (status === "pending") return "bg-amber-500/15 text-amber-200";
  if (status === "reschedule_requested") return "bg-sky-500/15 text-sky-300";
  if (status === "completed") return "bg-violet-500/15 text-violet-300";
  if (status === "no_show") return "bg-orange-500/15 text-orange-200";
  if (status === "cancelled") return "bg-destructive/15 text-destructive-text";
  return "bg-muted text-muted-foreground";
}

function listingLabel(listing, unitNameById) {
  const unitLabel = unitNameById.get(listing.unitId) || "Unknown unit";
  const title = listing.metadata?.title || listing.metadata?.headline || listing.listingExternalId || "Listing";
  const platform = typeof listing?.platform === "string" ? listing.platform.toUpperCase() : "";
  const label = platform ? `${platform} · ${title}` : title;
  return `${label} · ${unitLabel}`;
}

function appointmentLeadLabel(item) {
  const lead = item?.conversation?.leadName || item?.unit || "Showing";
  const platform = typeof item?.conversation?.platform === "string"
    ? item.conversation.platform.toUpperCase()
    : "";
  return platform ? `${platform} · ${lead}` : lead;
}

export function ShowingsPanel() {
  const {
    units,
    listings,
    agents,
    appointments,
    refreshAppointments,
  } = useLeaseBot();

  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [statusFilter, setStatusFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [listingFilter, setListingFilter] = useState("all");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const unitNameById = useMemo(
    () => new Map(units.map((unit) => [unit.id, `${unit.propertyName} ${unit.unitNumber}`])),
    [units]
  );

  const listingById = useMemo(
    () => new Map(listings.map((listing) => [listing.id, listing])),
    [listings]
  );

  const filteredListings = useMemo(
    () => listings.filter((listing) => listing.status === "active"),
    [listings]
  );

  const selectedListing = listingFilter !== "all" ? listingById.get(listingFilter) : null;

  async function loadCalendarData() {
    const windowStart = startOfWeek(startOfMonth(calendarMonth), { weekStartsOn: 0 });
    const windowEnd = endOfWeek(endOfMonth(calendarMonth), { weekStartsOn: 0 });

    setIsRefreshing(true);
    try {
      await refreshAppointments({
        status: statusFilter,
        agentId: agentFilter,
        unitId: selectedListing?.unitId || "all",
        fromDate: format(windowStart, "yyyy-MM-dd"),
        toDate: format(windowEnd, "yyyy-MM-dd")
      });
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    void loadCalendarData();
  }, [calendarMonth, statusFilter, agentFilter, listingFilter]);

  const visibleAppointments = useMemo(() => {
    let items = appointments;
    if (listingFilter !== "all") {
      items = items.filter((item) => item.listingId === listingFilter);
    }
    return items;
  }, [appointments, listingFilter]);

  const dayItemsByKey = useMemo(() => {
    const bucket = new Map();
    for (const item of visibleAppointments) {
      const startsAt = safeDate(item.startsAt);
      if (!startsAt) continue;
      const key = dayKeyFromDate(startsAt);
      if (!bucket.has(key)) {
        bucket.set(key, []);
      }
      bucket.get(key).push(item);
    }

    for (const entry of bucket.values()) {
      entry.sort((left, right) => {
        const leftTs = safeDate(left.startsAt)?.getTime() || 0;
        const rightTs = safeDate(right.startsAt)?.getTime() || 0;
        return leftTs - rightTs;
      });
    }

    return bucket;
  }, [visibleAppointments]);

  const selectedDayItems = useMemo(() => {
    const key = dayKeyFromDate(selectedDate);
    return dayItemsByKey.get(key) || [];
  }, [dayItemsByKey, selectedDate]);

  const monthGridDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(calendarMonth), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(calendarMonth), { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [calendarMonth]);

  const upcomingItems = useMemo(() => {
    const nowTs = Date.now();
    return [...visibleAppointments]
      .sort((left, right) => {
        const leftTs = safeDate(left.startsAt)?.getTime() || 0;
        const rightTs = safeDate(right.startsAt)?.getTime() || 0;
        return leftTs - rightTs;
      })
      .filter((item) => {
        const startsAt = safeDate(item.startsAt);
        return startsAt && startsAt.getTime() >= nowTs;
      })
      .slice(0, 10);
  }, [visibleAppointments]);

  return (
    <div className="px-4 py-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
          <span>Calendar-driven showings</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{visibleAppointments.length} events</span>
        </div>

        <div className="grid gap-2 md:grid-cols-4">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {SHOWING_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>{agent.fullName}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={listingFilter} onValueChange={setListingFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Listing" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All listings</SelectItem>
              {filteredListings.map((listing) => (
                <SelectItem key={listing.id} value={listing.id}>{listingLabel(listing, unitNameById)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            type="button"
            variant="secondary"
            className="justify-center"
            onClick={() => void loadCalendarData()}
            disabled={isRefreshing}
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
              {[
                "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
              ].map((day) => (
                <div key={day}>{day}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {monthGridDays.map((day) => {
                const key = dayKeyFromDate(day);
                const dayItems = dayItemsByKey.get(key) || [];
                const isCurrentMonth = day.getMonth() === calendarMonth.getMonth();
                const isSelected = isSameDay(day, selectedDate);

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedDate(day)}
                    className={cn(
                      "min-h-[92px] rounded-md border border-border p-2 text-left transition",
                      isSelected && "border-primary bg-primary/10",
                      !isSelected && "hover:bg-muted/40",
                      !isCurrentMonth && "opacity-50"
                    )}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{format(day, "d")}</span>
                      {dayItems.length > 0 ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground">
                          {dayItems.length}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 space-y-1">
                      {dayItems.slice(0, 2).map((item) => (
                        <div key={item.id} className="truncate rounded bg-muted/60 px-1.5 py-0.5 text-[10px]">
                          {format(safeDate(item.startsAt) || new Date(), "HH:mm")} · {item.agentName || "Agent"}
                        </div>
                      ))}
                      {dayItems.length > 2 ? (
                        <div className="text-[10px] text-muted-foreground">+{dayItems.length - 2} more</div>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-md border border-border bg-card p-3">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">{format(selectedDate, "EEE, MMM d")}</p>
                <p className="text-xs text-muted-foreground">{selectedDayItems.length} showing(s)</p>
              </div>
              <ListFilter className="h-4 w-4 text-muted-foreground" />
            </div>

            {selectedDayItems.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                No showings on selected day.
              </div>
            ) : (
              <div className="space-y-2">
                {selectedDayItems.map((item) => (
                  <div key={item.id} className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{appointmentLeadLabel(item)}</p>
                      <Badge className={statusTone(item.status)}>{item.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{item.agentName || "Unassigned agent"}</p>
                    <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock3 className="h-3.5 w-3.5" />
                      <span>{item.localStart} - {item.localEnd}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upcoming</p>
              <div className="space-y-2">
                {upcomingItems.map((item) => (
                  <div key={`upcoming-${item.id}`} className="rounded-md border border-border px-3 py-2">
                    <p className="truncate text-xs font-medium">{appointmentLeadLabel(item)}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{item.localStart} · {item.agentName || "Agent"}</p>
                  </div>
                ))}
                {upcomingItems.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No upcoming showings.</p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
