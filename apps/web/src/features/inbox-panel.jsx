import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";
import { useEffect, useMemo, useState } from "react";

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
    refreshInbox
  } = useLeaseBot();
  const [inboxPage, setInboxPage] = useState(1);
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

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Inbox + Conversation</h3>
        <Badge>Status flow: new, draft, sent, hold</Badge>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,18rem)_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Inbox list</CardTitle>
            <CardDescription>Card fallback for mobile screens</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label>
              Filter
              <Select value={selectedInboxStatus} onChange={(event) => setSelectedInboxStatus(event.target.value)}>
                <option value="all">all</option>
                <option value="new">new</option>
                <option value="draft">draft</option>
                <option value="sent">sent</option>
                <option value="hold">hold</option>
              </Select>
            </Label>
            <Button type="button" variant="outline" className="w-full" onClick={() => refreshInbox(selectedInboxStatus, false)}>
              Refresh inbox
            </Button>
            <div className="space-y-2" data-testid="inbox-card-list">
              {pagedInboxItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid="inbox-row"
                  className={`w-full rounded-md border p-3 text-left ${
                    selectedConversationId === item.id ? "border-primary bg-secondary" : "border-border"
                  }`}
                  onClick={() => setSelectedConversationId(item.id)}
                >
                  <div className="text-sm font-semibold">{item.leadName || item.externalThreadId || "Unknown lead"}</div>
                  <div className="text-xs text-muted-foreground">{item.unit || "No unit assigned"}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Latest: {item.latestMessage || "n/a"}</div>
                </button>
              ))}
              {inboxItems.length === 0 ? <p className="text-sm text-muted-foreground">No inbox rows yet.</p> : null}
              {inboxItems.length > 0 ? (
                <div className="space-y-2 rounded-md border border-border p-2" data-testid="inbox-pagination-summary">
                  <p className="text-xs text-muted-foreground">
                    Showing {pagedInboxItems.length} of {inboxItems.length} inbox threads (page {inboxPage} of {inboxPageCount})
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={inboxPage <= 1}
                      onClick={() => setInboxPage((current) => Math.max(1, current - 1))}
                    >
                      Previous page
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={inboxPage >= inboxPageCount}
                      onClick={() => setInboxPage((current) => Math.min(inboxPageCount, current + 1))}
                    >
                      Next page
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversation detail</CardTitle>
            <CardDescription>One-handed actions with sticky composer</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {conversationDetail ? (
              <>
                <div className="rounded-md bg-muted p-3 text-sm">
                  <p className="font-semibold">{conversationDetail.conversation.leadName || "Unknown lead"}</p>
                  <p className="text-muted-foreground">Unit: {conversationDetail.conversation.unit || "n/a"}</p>
                  <p className="text-muted-foreground">
                    Variables: unit={conversationDetail.templateContext?.unit || ""} slot={conversationDetail.templateContext?.slot || ""}
                  </p>
                </div>
                <div className="space-y-2">
                  {(conversationDetail.messages || []).map((item) => (
                    <div key={item.id} className="rounded-md border border-border p-3">
                      <p className="text-sm font-medium">
                        {item.direction} [{item.status}]
                      </p>
                      <p className="mt-1 text-sm">{item.body}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{formatTimestamp(item.createdAt)}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.status === "draft" ? (
                          <>
                            <Button type="button" size="sm" onClick={() => approveMessage(item.id)}>
                              Approve
                            </Button>
                            <Button type="button" size="sm" variant="outline" onClick={() => rejectMessage(item.id)}>
                              Reject
                            </Button>
                          </>
                        ) : null}
                        {item.status === "hold" ? (
                          <Button type="button" size="sm" onClick={() => approveMessage(item.id)}>
                            Approve
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                <form onSubmit={createDraft} className="sticky bottom-0 z-10 space-y-2 rounded-md border border-border bg-card p-3">
                  <Label>
                    Template
                    <Select
                      value={draftForm.templateId}
                      onChange={(event) => {
                        const templateId = event.target.value;
                        const template = (conversationDetail.templates || []).find((item) => item.id === templateId);
                        setDraftForm((current) => ({ ...current, templateId, body: template ? template.body : current.body }));
                      }}
                    >
                      <option value="">No template</option>
                      {(conversationDetail.templates || []).map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </Select>
                  </Label>
                  <Label>
                    Message body
                    <Textarea
                      rows={3}
                      placeholder="Optional manual body"
                      value={draftForm.body}
                      onChange={(event) => setDraftForm((current) => ({ ...current, body: event.target.value }))}
                    />
                  </Label>
                  <Button type="submit" className="w-full">
                    Create draft / send
                  </Button>
                </form>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Select a conversation to see detail.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
