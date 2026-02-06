import { RefreshCw, ChevronLeft, ChevronRight, Send, Check, X, MessageSquare, User, Building2, ArrowLeft } from "lucide-react";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";

const INBOX_PAGE_SIZE = 20;

export function InboxPanel() {
  const {
    inboxItems,
    selectedInboxStatus,
    setSelectedInboxStatus,
    selectedConversationId,
    setSelectedConversationId,
    conversationDetail,
    draftForm,
    setDraftForm,
    createDraft,
    approveMessage,
    rejectMessage,
    refreshInbox,
  } = useLeaseBot();
  const [inboxPage, setInboxPage] = useState(1);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const inboxPageCount = Math.max(1, Math.ceil(inboxItems.length / INBOX_PAGE_SIZE));
  const pagedInboxItems = useMemo(() => {
    const start = (inboxPage - 1) * INBOX_PAGE_SIZE;
    return inboxItems.slice(start, start + INBOX_PAGE_SIZE);
  }, [inboxItems, inboxPage]);

  useEffect(() => {
    setInboxPage(1);
  }, [selectedInboxStatus, inboxItems.length]);

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

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        {/* Thread list sidebar - full width on mobile, fixed width on desktop */}
        <div className={cn(
          "flex shrink-0 flex-col border-r border-border",
          "w-full md:w-80",
          mobileShowDetail && "hidden md:flex"
        )}>
          {/* Thread list header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Select
              value={selectedInboxStatus}
              onChange={(event) => setSelectedInboxStatus(event.target.value)}
              className="h-9 flex-1 text-sm"
            >
              <option value="all">All threads</option>
              <option value="new">New</option>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="hold">Hold</option>
            </Select>
            <button
              type="button"
              onClick={handleRefreshInbox}
              disabled={isRefreshing}
              className="ml-2 rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </button>
          </div>

          {/* Thread list */}
          <div className="flex-1 overflow-y-auto" data-testid="inbox-card-list">
            {pagedInboxItems.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid="inbox-row"
                className={cn(
                  "flex w-full cursor-pointer flex-col border-b border-border px-4 py-3 text-left transition-colors",
                  selectedConversationId === item.id
                    ? "bg-primary/5"
                    : "hover:bg-muted/50"
                )}
                onClick={() => handleSelectConversation(item.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {item.leadName || item.externalThreadId || "Unknown lead"}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {item.status}
                  </span>
                </div>
                <span className="mt-0.5 text-xs text-muted-foreground">
                  {item.unit || "No unit"}
                </span>
                <span className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">
                  {item.latestMessage || "No messages yet"}
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
            <div className="flex items-center justify-between border-t border-border px-4 py-2" data-testid="inbox-pagination-summary">
              <span className="text-xs text-muted-foreground">
                {inboxPage} / {inboxPageCount}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  disabled={inboxPage <= 1}
                  onClick={() => setInboxPage((c) => Math.max(1, c - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
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

        {/* Conversation detail - hidden on mobile when showing list */}
        <div className={cn(
          "flex min-w-0 flex-1 flex-col",
          !mobileShowDetail && "hidden md:flex"
        )}>
          {conversationDetail ? (
            <>
              {/* Conversation header */}
              <div className="flex items-center gap-3 border-b border-border px-4 py-3 md:gap-4 md:px-6 md:py-4">
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
                    {conversationDetail.templateContext?.slot ? (
                      <span>Slot: {conversationDetail.templateContext.slot}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6">
                <div className="mx-auto max-w-2xl space-y-3">
                  {(conversationDetail.messages || []).length === 0 ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                      No messages in this thread.
                    </p>
                  ) : null}
                  {(conversationDetail.messages || []).map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        "max-w-[90%] rounded-xl px-4 py-3 md:max-w-[85%]",
                        item.direction === "outbound"
                          ? "ml-auto bg-primary/10"
                          : "bg-muted"
                      )}
                    >
                      <p className="text-sm leading-relaxed">{item.body}</p>
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="text-[11px] text-muted-foreground">
                          {formatTimestamp(item.createdAt)}
                        </span>
                        <span className="text-[11px] font-medium capitalize text-muted-foreground">
                          {item.status}
                        </span>
                      </div>
                      {item.status === "draft" || item.status === "hold" ? (
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => approveMessage(item.id)}
                            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                          >
                            <Check className="h-3 w-3" />
                            Approve
                          </button>
                          {item.status === "draft" ? (
                            <button
                              type="button"
                              onClick={() => rejectMessage(item.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                            >
                              <X className="h-3 w-3" />
                              Reject
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              {/* Compose */}
              <div className="border-t border-border px-4 py-3 md:px-6 md:py-4">
                <form onSubmit={createDraft} className="mx-auto max-w-2xl">
                  <div className="mb-3">
                    <Select
                      value={draftForm.templateId}
                      onChange={(event) => {
                        const templateId = event.target.value;
                        const template = (conversationDetail.templates || []).find(
                          (t) => t.id === templateId
                        );
                        setDraftForm((c) => ({
                          ...c,
                          templateId,
                          body: template ? template.body : c.body,
                        }));
                      }}
                      className="h-9 text-sm"
                    >
                      <option value="">No template</option>
                      {(conversationDetail.templates || []).map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Textarea
                      rows={2}
                      placeholder="Type your message..."
                      value={draftForm.body}
                      onChange={(e) => setDraftForm((c) => ({ ...c, body: e.target.value }))}
                      className="min-h-[2.5rem] flex-1 resize-none text-sm"
                    />
                    <Button type="submit" size="icon" className="h-11 w-11 shrink-0">
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
