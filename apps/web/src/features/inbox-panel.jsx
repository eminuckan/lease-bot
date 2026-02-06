import { RefreshCw, ChevronLeft, ChevronRight, Send } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { useEffect, useMemo, useState } from "react";

const INBOX_PAGE_SIZE = 20;

export function InboxPanel() {
  const {
    apiError,
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

  async function handleRefreshInbox() {
    setIsRefreshing(true);
    try {
      await refreshInbox(selectedInboxStatus, false);
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Inbox</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefreshInbox}
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
        {/* Thread list */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Select
              value={selectedInboxStatus}
              onChange={(event) => setSelectedInboxStatus(event.target.value)}
              className="flex-1"
            >
              <option value="all">All threads</option>
              <option value="new">New</option>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="hold">Hold</option>
            </Select>
            <Badge variant="secondary">{inboxItems.length}</Badge>
          </div>

          <div className="space-y-1" data-testid="inbox-card-list">
            {pagedInboxItems.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid="inbox-row"
                className={`w-full cursor-pointer rounded-lg border p-3 text-left transition-colors ${
                  selectedConversationId === item.id
                    ? "border-primary/50 bg-primary/5"
                    : "border-transparent hover:bg-muted"
                }`}
                onClick={() => setSelectedConversationId(item.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium">
                    {item.leadName || item.externalThreadId || "Unknown lead"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.unit || "No unit assigned"}
                </p>
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                  {item.latestMessage || "No messages yet"}
                </p>
              </button>
            ))}
            {inboxItems.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No conversations yet.
              </p>
            ) : null}
          </div>

          {inboxItems.length > INBOX_PAGE_SIZE ? (
            <div className="flex items-center justify-between pt-1" data-testid="inbox-pagination-summary">
              <p className="text-xs text-muted-foreground">
                Page {inboxPage} of {inboxPageCount}
              </p>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  disabled={inboxPage <= 1}
                  onClick={() => setInboxPage((current) => Math.max(1, current - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  disabled={inboxPage >= inboxPageCount}
                  onClick={() => setInboxPage((current) => Math.min(inboxPageCount, current + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Conversation detail */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {conversationDetail
                ? conversationDetail.conversation.leadName || "Conversation"
                : "Conversation"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {conversationDetail ? (
              <>
                <div className="rounded-md bg-muted/50 p-3 text-sm">
                  <p className="text-muted-foreground">
                    Unit: {conversationDetail.conversation.unit || "n/a"}
                  </p>
                  {conversationDetail.templateContext?.slot ? (
                    <p className="text-muted-foreground">
                      Slot: {conversationDetail.templateContext.slot}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  {(conversationDetail.messages || []).length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      No messages in this thread.
                    </p>
                  ) : null}
                  {(conversationDetail.messages || []).map((item) => (
                    <div
                      key={item.id}
                      className={`rounded-lg border p-3 ${
                        item.direction === "outbound"
                          ? "ml-4 border-primary/20 bg-primary/5"
                          : "mr-4"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium capitalize text-muted-foreground">
                          {item.direction}
                        </span>
                        <Badge variant="secondary" className="text-[10px]">
                          {item.status}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-sm">{item.body}</p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        {formatTimestamp(item.createdAt)}
                      </p>
                      {item.status === "draft" || item.status === "hold" ? (
                        <div className="mt-2 flex gap-2">
                          <Button type="button" size="sm" onClick={() => approveMessage(item.id)}>
                            Approve
                          </Button>
                          {item.status === "draft" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => rejectMessage(item.id)}
                            >
                              Reject
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>

                <form
                  onSubmit={createDraft}
                  className="sticky bottom-0 z-10 space-y-3 rounded-lg border border-border bg-card p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <Select
                      value={draftForm.templateId}
                      onChange={(event) => {
                        const templateId = event.target.value;
                        const template = (conversationDetail.templates || []).find(
                          (item) => item.id === templateId
                        );
                        setDraftForm((current) => ({
                          ...current,
                          templateId,
                          body: template ? template.body : current.body,
                        }));
                      }}
                    >
                      <option value="">No template</option>
                      {(conversationDetail.templates || []).map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Textarea
                    rows={2}
                    placeholder="Type your message..."
                    value={draftForm.body}
                    onChange={(event) =>
                      setDraftForm((current) => ({ ...current, body: event.target.value }))
                    }
                  />
                  <Button type="submit" className="w-full" size="sm">
                    <Send className="mr-2 h-3.5 w-3.5" />
                    Send draft
                  </Button>
                </form>
              </>
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Select a conversation to view details.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
