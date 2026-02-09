// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockLeaseBot = vi.hoisted(() => ({
  inboxItems: [],
  inboxLoading: false,
  selectedInboxStatus: "all",
  setSelectedInboxStatus: vi.fn(),
  selectedInboxPlatform: "all",
  setSelectedInboxPlatform: vi.fn(),
  selectedConversationId: "",
  setSelectedConversationId: vi.fn(),
  conversationDetail: null,
  conversationLoading: false,
  conversationRefreshing: false,
  draftForm: { body: "" },
  setDraftForm: vi.fn(),
  createDraft: vi.fn((event) => event?.preventDefault?.()),
  updateConversationWorkflow: vi.fn(async () => ({})),
  approveMessage: vi.fn(async () => ({})),
  rejectMessage: vi.fn(async () => ({})),
  refreshInbox: vi.fn(async () => ({})),
  appointments: []
}));

vi.mock("../state/lease-bot-context", () => ({
  useLeaseBot: () => mockLeaseBot
}));

import { InboxPanel } from "./inbox-panel";

function buildInboxItems() {
  return [
    {
      id: "11111111-1111-4111-8111-111111111111",
      leadName: "Hold Lead",
      latestMessage: "Need a person",
      workflowOutcome: "human_required",
      latestStatus: "new",
      followUpStatus: null,
      followUpDueAt: null,
      conversationStatus: "open"
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      leadName: "Follow Up Lead",
      latestMessage: "Can we reschedule?",
      workflowOutcome: "general_question",
      latestStatus: "hold",
      followUpStatus: "pending",
      followUpDueAt: "2026-02-07T09:00:00.000Z",
      conversationStatus: "open"
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      leadName: "Done Lead",
      latestMessage: "Thanks",
      workflowOutcome: "completed",
      latestStatus: "sent",
      followUpStatus: "completed",
      followUpDueAt: "2026-02-08T09:00:00.000Z",
      conversationStatus: "closed"
    }
  ];
}

describe("InboxPanel workboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeaseBot.inboxItems = buildInboxItems();
    mockLeaseBot.selectedInboxStatus = "all";
    mockLeaseBot.selectedConversationId = "11111111-1111-4111-8111-111111111111";
    mockLeaseBot.appointments = [
      { id: "a1", startsAt: `${new Date().toISOString().slice(0, 10)}T10:00:00.000Z` },
      { id: "a2", startsAt: "2099-01-01T10:00:00.000Z" }
    ];
    mockLeaseBot.conversationDetail = {
      conversation: {
        id: "11111111-1111-4111-8111-111111111111",
        leadName: "Hold Lead",
        unit: "Atlas 4B"
      },
      messages: [],
      templates: [],
      templateContext: {}
    };
  });

  it("R25/R26: renders simplified workboard counters and keeps thread selection", async () => {
    render(<InboxPanel />);

    expect(screen.getAllByText(/Human required/i).length > 0).toBe(true);
    expect(screen.getAllByText(/Today showings/i).length > 0).toBe(true);
    expect(screen.queryByText(/Follow-up queue/i)).toBeNull();
    expect(screen.queryByText(/Daily plan/i)).toBeNull();

    expect(screen.getAllByText("2").length > 0).toBe(true);
    expect(screen.getAllByText("1").length > 0).toBe(true);
    expect(screen.getAllByRole("button", { name: /Hold Lead/i }).length > 0).toBe(true);
    expect(screen.getAllByRole("button", { name: /Follow Up Lead/i }).length > 0).toBe(true);

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /Follow Up Lead/i })[0]);
    expect(mockLeaseBot.setSelectedConversationId).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("R27: one-click outcome actions call workflow API with expected payload", async () => {
    render(<InboxPanel />);
    const user = userEvent.setup();

    await user.click(screen.getAllByRole("button", { name: "Not interested" })[0]);
    await user.click(screen.getAllByRole("button", { name: "Reschedule" })[0]);
    await user.click(screen.getAllByRole("button", { name: "No show" })[0]);
    await user.click(screen.getAllByRole("button", { name: "Completed" })[0]);

    expect(mockLeaseBot.updateConversationWorkflow).toHaveBeenNthCalledWith(
      1,
      "11111111-1111-4111-8111-111111111111",
      { workflowOutcome: "not_interested" },
      "Outcome updated: not interested"
    );
    expect(mockLeaseBot.updateConversationWorkflow).toHaveBeenNthCalledWith(
      2,
      "11111111-1111-4111-8111-111111111111",
      { workflowOutcome: "wants_reschedule", showingState: "reschedule_requested" },
      "Outcome updated: wants reschedule"
    );
    expect(mockLeaseBot.updateConversationWorkflow).toHaveBeenNthCalledWith(
      3,
      "11111111-1111-4111-8111-111111111111",
      { workflowOutcome: "no_show", showingState: "no_show" },
      "Outcome updated: no show"
    );
    expect(mockLeaseBot.updateConversationWorkflow).toHaveBeenNthCalledWith(
      4,
      "11111111-1111-4111-8111-111111111111",
      { workflowOutcome: "completed", showingState: "completed" },
      "Outcome updated: completed"
    );
  });

  it("binds row status to conversationStatus field", () => {
    render(<InboxPanel />);
    expect(screen.getAllByText("open").length > 0).toBe(true);
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("shows Approve only for outbound hold/draft messages", async () => {
    mockLeaseBot.conversationDetail = {
      conversation: {
        id: "11111111-1111-4111-8111-111111111111",
        leadName: "Hold Lead",
        unit: "Atlas 4B"
      },
      messages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          direction: "inbound",
          status: "hold",
          body: "Need details",
          sentAt: "2026-02-08T12:00:00.000Z"
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          direction: "outbound",
          status: "hold",
          body: "Draft reply",
          sentAt: "2026-02-08T12:01:00.000Z"
        }
      ],
      templates: [],
      templateContext: {}
    };

    render(<InboxPanel />);
    const approveButtons = screen.getAllByRole("button", { name: "Approve" });
    expect(approveButtons).toHaveLength(1);

    const user = userEvent.setup();
    await user.click(approveButtons[0]);
    expect(mockLeaseBot.approveMessage).toHaveBeenCalledWith("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });
});
