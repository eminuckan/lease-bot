import { RefreshCw, ChevronLeft, ChevronRight, Send, Check, X, MessageSquare, User, Building2, ArrowLeft } from "lucide-react";
import { Button } from "../components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";

const INBOX_PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: "all", label: "All threads" },
  { value: "new", label: "New" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "hold", label: "Hold" },
];

const PLATFORM_OPTIONS = [
  { value: "all", label: "All platforms" },
  { value: "spareroom", label: "SpareRoom" },
  { value: "roomies", label: "Roomies" },
  { value: "leasebreak", label: "Leasebreak" },
  { value: "renthop", label: "RentHop" },
  { value: "furnishedfinder", label: "FurnishedFinder" }
];

export function InboxPanel() {
  const {
    inboxItems,
    selectedInboxStatus,
    setSelectedInboxStatus,
    selectedInboxPlatform,
    setSelectedInboxPlatform,
    selectedConversationId,
    setSelectedConversationId,
    conversationDetail,
    draftForm,
    setDraftForm,
    createDraft,
    updateConversationWorkflow,
    approveMessage,
    rejectMessage,
    refreshInbox,
    appointments,
  } = useLeaseBot();
  const [inboxPage, setInboxPage] = useState(1);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const inboxPageCount = Math.max(1, Math.ceil(inboxItems.length / INBOX_PAGE_SIZE));
  const pagedInboxItems = useMemo(() => {
    const start = (inboxPage - 1) * INBOX_PAGE_SIZE;
    return inboxItems.slice(start, start + INBOX_PAGE_SIZE);
  }, [inboxItems, inboxPage]);
  const todayKey = new Date().toISOString().slice(0, 10);
  const humanRequiredQueue = useMemo(
    () => inboxItems.filter((item) => item.workflowOutcome === "human_required" || item.latestStatus === "hold"),
    [inboxItems]
  );
  const followUpQueue = useMemo(
    () => inboxItems
      .filter((item) => item.followUpStatus === "pending" && item.followUpDueAt)
      .sort((a, b) => new Date(a.followUpDueAt).getTime() - new Date(b.followUpDueAt).getTime()),
    [inboxItems]
  );
  const todaysShowings = useMemo(
    () => appointments.filter((item) => (item.startsAt || "").slice(0, 10) === todayKey),
    [appointments, todayKey]
  );

  useEffect(() => {
    setInboxPage(1);
  }, [selectedInboxStatus, selectedInboxPlatform, inboxItems.length]);

  useEffect(() => {
    if (inboxPage > inboxPageCount) {
      setInboxPage(inboxPageCount);
    }
  }, [inboxPage, inboxPageCount]);

  function handleSelectConversation(id) {
    setSelectedConversationId(id);
    setMobileShowDetail(true);
  }

  async function handleRefreshInbox() {
    setIsRefreshing(true);
    try {
      await refreshInbox(selectedInboxStatus, false);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleOneClickOutcome(outcome) {
    if (!conversationDetail?.conversation?.id) {
      return;
    }

    const payloadByOutcome = {
      not_interested: { workflowOutcome: "not_interested" },
      wants_reschedule: { workflowOutcome: "wants_reschedule", showingState: "reschedule_requested" },
      no_show: { workflowOutcome: "no_show", showingState: "no_show" },
      completed: { workflowOutcome: "completed", showingState: "completed" }
    };

    const labelByOutcome = {
      not_interested: "Outcome updated: not interested",
      wants_reschedule: "Outcome updated: wants reschedule",
      no_show: "Outcome updated: no show",
      completed: "Outcome updated: completed"
    };

    await updateConversationWorkflow(conversationDetail.conversation.id, payloadByOutcome[outcome], labelByOutcome[outcome]);
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        {/* Thread list sidebar */}
        <div className={cn(
          "flex shrink-0 flex-col border-r border-dashed border-border bg-card",
          "w-full md:w-80",
          mobileShowDetail && "hidden md:flex"
        )}>
          {/* Thread list header */}
          <div className="flex items-center gap-2 px-2 py-3">
            <Select value={selectedInboxStatus} onValueChange={setSelectedInboxStatus}>
              <SelectTrigger className="h-9 flex-1 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedInboxPlatform} onValueChange={setSelectedInboxPlatform}>
              <SelectTrigger className="h-9 w-36 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={handleRefreshInbox}
              disabled={isRefreshing}
              className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 px-2 pb-2">
            <div className="rounded-md bg-muted px-2 py-2">
              <p className="text-[11px] text-muted-foreground">Human required</p>
              <p className="text-sm font-semibold">{humanRequiredQueue.length}</p>
            </div>
            <div className="rounded-md bg-muted px-2 py-2">
              <p className="text-[11px] text-muted-foreground">Today showings</p>
              <p className="text-sm font-semibold">{todaysShowings.length}</p>
            </div>
            <div className="rounded-md bg-muted px-2 py-2">
              <p className="text-[11px] text-muted-foreground">Follow-up queue</p>
              <p className="text-sm font-semibold">{followUpQueue.length}</p>
            </div>
            <div className="rounded-md bg-muted px-2 py-2">
              <p className="text-[11px] text-muted-foreground">Daily plan</p>
              <p className="text-sm font-semibold">{humanRequiredQueue.length + todaysShowings.length + followUpQueue.length}</p>
            </div>
          </div>

          <div className="space-y-2 px-2 pb-2">
            <QueuePreview title="Human required" items={humanRequiredQueue} onSelect={handleSelectConversation} />
            <QueuePreview title="Follow-up due" items={followUpQueue} onSelect={handleSelectConversation} />
          </div>

          {/* Thread list */}
          <div className="flex-1 overflow-y-auto px-2" data-testid="inbox-card-list">
            {pagedInboxItems.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid="inbox-row"
                className={cn(
                  "flex w-full cursor-pointer flex-col rounded-md px-3 py-3 text-left transition-all mb-0.5",
                  selectedConversationId === item.id
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                )}
                onClick={() => handleSelectConversation(item.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {item.leadName || item.externalThreadId || "Unknown lead"}
                    {Number.isFinite(item.threadMessageCount) && item.threadMessageCount > 0 ? ` (${item.threadMessageCount})` : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    {item.platform ? (
                      <span className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                        selectedConversationId === item.id
                          ? "bg-primary-foreground/15 text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      )}>
                        {item.platform}
                      </span>
                    ) : null}
                    <span className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                      selectedConversationId === item.id
                        ? "bg-primary-foreground/15 text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {item.conversationStatus || item.messageStatus || item.status || "unknown"}
                    </span>
                  </div>
                </div>
                <div className={cn(
                  "mt-0.5 flex items-center justify-between gap-2 text-xs",
                  selectedConversationId === item.id ? "text-primary-foreground/70" : "text-muted-foreground"
                )}>
                  <span className="truncate">{item.unit || "No unit"}</span>
                  <span className="shrink-0">{item.latestSentAtText || formatTimestamp(item.lastMessageAt)}</span>
                </div>
                <span className={cn(
                  "mt-1 line-clamp-1 text-xs",
                  selectedConversationId === item.id ? "text-primary-foreground/50" : "text-muted-foreground/70"
                )}>
                  {item.latestMessage
                    ? item.latestDirection === "outbound"
                      ? `You: ${item.latestMessage}`
                      : item.latestMessage
                    : "No messages yet"}
                </span>
              </button>
            ))}
            {inboxItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <MessageSquare className="mb-2 h-8 w-8 opacity-30" />
                <p className="text-sm">No conversations</p>
              </div>
            ) : null}
          </div>

          {/* Pagination */}
          {inboxItems.length > INBOX_PAGE_SIZE ? (
            <div className="flex items-center justify-between px-4 py-2" data-testid="inbox-pagination-summary">
              <span className="text-xs text-muted-foreground">
                {inboxPage} / {inboxPageCount}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  disabled={inboxPage <= 1}
                  onClick={() => setInboxPage((c) => Math.max(1, c - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  disabled={inboxPage >= inboxPageCount}
                  onClick={() => setInboxPage((c) => Math.min(inboxPageCount, c + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Conversation detail */}
        <div className={cn(
          "flex min-w-0 flex-1 flex-col bg-background",
          !mobileShowDetail && "hidden md:flex"
        )}>
          {conversationDetail ? (
            <>
              {/* Conversation header */}
              <div className="flex items-center gap-3 border-b border-dashed border-border bg-card px-4 py-3 md:gap-4 md:px-6 md:py-4">
                {/* Back button - mobile only */}
                <button
                  type="button"
                  onClick={() => setMobileShowDetail(false)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
                  aria-label="Back to threads"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <User className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold">
                    {conversationDetail.conversation.leadName || "Conversation"}
                  </h2>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {conversationDetail.conversation.unit ? (
                      <span className="flex items-center gap-1">
                        <Building2 className="h-3 w-3" />
                        {conversationDetail.conversation.unit}
                      </span>
                    ) : null}
                    {conversationDetail.conversation.platform ? (
                      <span className="uppercase tracking-wide">{conversationDetail.conversation.platform}</span>
                    ) : null}
                    {conversationDetail.templateContext?.slot ? (
                      <span>Slot: {conversationDetail.templateContext.slot}</span>
                    ) : null}
                  </div>
                </div>
                <div className="hidden items-center gap-1 md:flex">
                  <Button type="button" variant="outline" size="sm" onClick={() => handleOneClickOutcome("not_interested")}>Not interested</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => handleOneClickOutcome("wants_reschedule")}>Reschedule</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => handleOneClickOutcome("no_show")}>No show</Button>
                  <Button type="button" size="sm" onClick={() => handleOneClickOutcome("completed")}>Completed</Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 border-b border-dashed border-border bg-card px-4 py-2 md:hidden">
                <Button type="button" variant="outline" size="sm" onClick={() => handleOneClickOutcome("not_interested")}>Not interested</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => handleOneClickOutcome("wants_reschedule")}>Reschedule</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => handleOneClickOutcome("no_show")}>No show</Button>
                <Button type="button" size="sm" onClick={() => handleOneClickOutcome("completed")}>Completed</Button>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-4 py-6 md:px-6">
                <div className="mx-auto max-w-2xl space-y-4">
                  {(conversationDetail.messages || []).length === 0 ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                      No messages in this thread.
                    </p>
                  ) : null}
                  {(conversationDetail.messages || []).map((item) => {
                    const isOutbound = item.direction === "outbound";
                    return (
                      <div
                        key={item.id}
                        className={cn("flex", isOutbound ? "justify-end" : "justify-start")}
                      >
                        <div
                          className={cn(
                            "max-w-[85%] rounded-lg px-4 py-3 md:max-w-[75%]",
                            isOutbound
                              ? "bg-primary text-primary-foreground"
                              : "bg-card shadow-card"
                          )}
                        >
                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>
                          <div className={cn(
                            "mt-2 flex items-center justify-between gap-4 text-[11px]",
                            isOutbound ? "text-primary-foreground/60" : "text-muted-foreground"
                          )}>
                            <span>{formatTimestamp(item.sentAt || item.createdAt)}</span>
                            <span className="font-medium capitalize">{item.status}</span>
                          </div>
                          {item.status === "draft" || item.status === "hold" ? (
                            <div className="mt-3 flex gap-2">
                              <button
                                type="button"
                                onClick={() => approveMessage(item.id)}
                                className={cn(
                                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                                  isOutbound
                                    ? "bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30"
                                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                                )}
                              >
                                <Check className="h-3 w-3" />
                                Approve
                              </button>
                              {item.status === "draft" ? (
                                <button
                                  type="button"
                                  onClick={() => rejectMessage(item.id)}
                                  className={cn(
                                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                                    isOutbound
                                      ? "bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20"
                                      : "bg-muted text-foreground hover:bg-accent"
                                  )}
                                >
                                  <X className="h-3 w-3" />
                                  Reject
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Compose */}
              <div className="border-t border-dashed border-border bg-card px-4 py-4 md:px-6">
                <form onSubmit={createDraft} className="mx-auto max-w-2xl space-y-3">
                  <div className="flex items-end gap-3">
                    <Textarea
                      rows={2}
                      placeholder="Type your message..."
                      value={draftForm.body}
                      onChange={(e) => setDraftForm((c) => ({ ...c, body: e.target.value }))}
                      className="min-h-[3rem] flex-1 resize-none text-sm"
                    />
                    <Button type="submit" size="icon" className="h-10 w-10 shrink-0">
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                </form>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
              <MessageSquare className="mb-3 h-10 w-10 opacity-20" />
              <p className="text-sm">Select a conversation</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QueuePreview({ title, items, onSelect }) {
  const preview = items.slice(0, 3);
  return (
    <div className="rounded-md border border-dashed border-border p-2">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        <span className="text-[11px] text-muted-foreground">{items.length}</span>
      </div>
      {preview.length === 0 ? (
        <p className="text-xs text-muted-foreground">No items</p>
      ) : (
        <div className="space-y-1">
          {preview.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className="w-full truncate rounded bg-muted px-2 py-1 text-left text-xs text-foreground hover:bg-accent"
            >
              {item.leadName || item.externalThreadId || "Conversation"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
