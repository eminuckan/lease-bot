import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
const defaultPlatformAccountId = "11111111-1111-1111-1111-111111111111";

function parseApiError(payload, fallback) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  if (payload.message) {
    return payload.message;
  }
  if (Array.isArray(payload.details) && payload.details.length > 0) {
    return payload.details.join("; ");
  }
  if (payload.error) {
    return payload.error;
  }
  return fallback;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    credentials: "include",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(parseApiError(payload, `Request failed (${response.status})`));
  }

  return payload;
}

const LeaseBotContext = createContext(null);

export function LeaseBotProvider({ children }) {
  const [health, setHealth] = useState("loading");
  const [user, setUser] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [apiError, setApiError] = useState("");
  const [message, setMessage] = useState("");
  const [agents, setAgents] = useState([]);
  const [units, setUnits] = useState([]);
  const [listings, setListings] = useState([]);
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [availability, setAvailability] = useState([]);
  const [weeklyRules, setWeeklyRules] = useState([]);
  const [assignmentForm, setAssignmentForm] = useState({ unitId: "", listingId: "", agentId: "" });
  const [inboxItems, setInboxItems] = useState([]);
  const [selectedInboxStatus, setSelectedInboxStatus] = useState("all");
  const [selectedInboxPlatform, setSelectedInboxPlatform] = useState("all");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [conversationDetail, setConversationDetail] = useState(null);
  const [draftForm, setDraftForm] = useState({ body: "" });
  const [syncedConversations, setSyncedConversations] = useState({});
  const [appointments, setAppointments] = useState([]);
  const [appointmentFilters, setAppointmentFilters] = useState({
    status: "all",
    unitId: "all",
    fromDate: "",
    toDate: ""
  });
  const [platformPolicies, setPlatformPolicies] = useState([]);
  const [platformHealth, setPlatformHealth] = useState([]);
  const [globalPlatformSendMode, setGlobalPlatformSendMode] = useState("draft_only");
  const [platformHealthGeneratedAt, setPlatformHealthGeneratedAt] = useState(null);
  const [adminUsers, setAdminUsers] = useState([]);
  const [userInvitations, setUserInvitations] = useState([]);

  const isAdmin = user?.role === "admin";
  const canAccessAgent = user?.role === "agent" || isAdmin;
  const selectedUnitListings = useMemo(
    () => listings.filter((item) => item.unitId === selectedUnitId),
    [listings, selectedUnitId]
  );

  async function refreshHealth() {
    try {
      const response = await fetch(`${apiBaseUrl}/health`);
      const data = await response.json();
      setHealth(data.status || "ok");
    } catch {
      setHealth("unreachable");
    }
  }

  async function refreshSession() {
    setSessionLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/me`, { credentials: "include" });
      if (!response.ok) {
        setUser(null);
        return null;
      }

      const data = await response.json();
      setUser(data.user || null);
      return data.user || null;
    } catch {
      setUser(null);
      return null;
    } finally {
      setSessionLoading(false);
    }
  }

  async function refreshConversationDetail(conversationId) {
    if (!conversationId) {
      setConversationDetail(null);
      return;
    }

    try {
      const result = await request(`/api/inbox/${conversationId}`);
      setConversationDetail(result);

      const platform = result?.conversation?.platform;
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      const threadMessageCount = Number(result?.conversation?.threadMessageCount);
      const shouldAutoSync = platform === "spareroom"
        && !syncedConversations[conversationId]
        && (
          messages.length <= 1
          || (Number.isFinite(threadMessageCount) && threadMessageCount > messages.length)
        );
      if (shouldAutoSync) {
        setSyncedConversations((current) => ({ ...current, [conversationId]: true }));
        try {
          const synced = await request(`/api/inbox/${conversationId}/sync`, { method: "POST" });
          setConversationDetail(synced);
          await refreshInbox(selectedInboxStatus, true, selectedInboxPlatform);
        } catch {
          // Best-effort; keep the previously fetched detail if sync fails.
        }
      }
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function refreshInbox(status = selectedInboxStatus, preserveSelection = true, platform = selectedInboxPlatform) {
    if (!user) {
      return;
    }

    try {
      const params = new URLSearchParams();
      if (status && status !== "all") {
        params.set("status", status);
      }
      if (platform && platform !== "all") {
        params.set("platform", platform);
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      const result = await request(`/api/inbox${query}`);
      const items = result.items || [];
      setInboxItems(items);

      setSelectedConversationId((current) => {
        if (preserveSelection && current && items.some((item) => item.id === current)) {
          return current;
        }
        return items[0]?.id || "";
      });
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function refreshAvailability(unitId) {
    if (!unitId) {
      setAvailability([]);
      setWeeklyRules([]);
      return;
    }

    try {
      const [availabilityResponse, weeklyRulesResponse] = await Promise.all([
        request(`/api/units/${unitId}/availability`),
        request(`/api/units/${unitId}/availability/weekly-rules`)
      ]);

      setAvailability(availabilityResponse.items || []);
      setWeeklyRules(weeklyRulesResponse.items || []);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function refreshAppointments(filters = appointmentFilters) {
    if (!user) {
      return;
    }

    const params = new URLSearchParams();
    if (filters.status && filters.status !== "all") {
      params.set("status", filters.status);
    }
    if (filters.unitId && filters.unitId !== "all") {
      params.set("unitId", filters.unitId);
    }
    if (filters.fromDate) {
      params.set("fromDate", filters.fromDate);
    }
    if (filters.toDate) {
      params.set("toDate", filters.toDate);
    }

    const query = params.toString() ? `?${params.toString()}` : "";

    try {
      const response = await request(`/api/showing-appointments${query}`);
      setAppointments(response.items || []);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function refreshAdminPlatformData() {
    if (!isAdmin) {
      return;
    }

    try {
      const [policyResponse, healthResponse] = await Promise.all([
        request("/api/admin/platform-policies"),
        request("/api/admin/platform-health")
      ]);

      setPlatformPolicies(policyResponse.items || []);
      setGlobalPlatformSendMode(policyResponse.globalDefaultSendMode || "draft_only");
      setPlatformHealth(healthResponse.items || []);
      setPlatformHealthGeneratedAt(healthResponse.generatedAt || null);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function refreshAdminUsers() {
    if (!isAdmin) {
      return;
    }

    try {
      const response = await request("/api/admin/users");
      setAdminUsers(response.users || []);
      setUserInvitations(response.invitations || []);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function createUserInvitation(payload) {
    if (!isAdmin) {
      return null;
    }

    setApiError("");
    setMessage("");
    try {
      const response = await request("/api/admin/users/invitations", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      const delivery = response?.invitation?.delivery === "email" ? "Invitation email sent" : "Invitation created";
      setMessage(delivery);
      toast.success(delivery, {
        description: response?.invitation?.previewUrl
          ? "SMTP disabled in dev; invite link returned in UI."
          : undefined
      });
      await refreshAdminUsers();
      return response.invitation || null;
    } catch (error) {
      setApiError(error.message);
      toast.error("Invite creation failed", { description: error.message });
      return null;
    }
  }

  async function revokeUserInvitation(invitationId) {
    if (!isAdmin || !invitationId) {
      return false;
    }

    setApiError("");
    setMessage("");
    try {
      await request(`/api/admin/users/invitations/${invitationId}/revoke`, {
        method: "POST"
      });
      setMessage("Invitation revoked");
      toast.success("Invitation revoked");
      await refreshAdminUsers();
      return true;
    } catch (error) {
      setApiError(error.message);
      toast.error("Invitation revoke failed", { description: error.message });
      return false;
    }
  }

  async function verifyInvitationToken(token) {
    const query = new URLSearchParams({ token }).toString();
    return request(`/api/invitations/verify?${query}`);
  }

  async function acceptInvitationToken({ token, password }) {
    return request("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token, password })
    });
  }

  async function updatePlatformPolicy(platformAccountId, updates) {
    if (!isAdmin || !platformAccountId) {
      return null;
    }

    setApiError("");
    setMessage("");
    try {
      const updated = await request(`/api/admin/platform-policies/${platformAccountId}`, {
        method: "PUT",
        body: JSON.stringify(updates)
      });
      setMessage(`Platform policy updated: ${updated.platform}`);
      toast.success("Platform policy updated", { description: updated.platform });
      await refreshAdminPlatformData();
      return updated;
    } catch (error) {
      setApiError(error.message);
      toast.error("Platform policy update failed", { description: error.message });
      return null;
    }
  }

  async function refreshData() {
    if (!user) {
      return;
    }

    setApiError("");
    try {
      const [agentsResponse, unitsResponse, listingsResponse] = await Promise.all([
        request("/api/agents"),
        request("/api/units"),
        request("/api/listings")
      ]);

      setAgents(agentsResponse.items || []);
      setUnits(unitsResponse.items || []);
      setListings(listingsResponse.items || []);

      const fallbackUnitId = selectedUnitId || unitsResponse.items?.[0]?.id || "";
      const fallbackListingId = listingsResponse.items?.[0]?.id || "";
      setSelectedUnitId((current) => current || fallbackUnitId);
      setAssignmentForm((current) => ({
        ...current,
        listingId: current.listingId || fallbackListingId,
        unitId:
          current.unitId
          || listingsResponse.items?.find((item) => item.id === current.listingId)?.unitId
          || listingsResponse.items?.find((item) => item.id === fallbackListingId)?.unitId
          || fallbackUnitId
      }));

      await Promise.all([
        refreshInbox(selectedInboxStatus, false, selectedInboxPlatform),
        refreshAvailability(fallbackUnitId),
        refreshAppointments(),
        ...(isAdmin ? [refreshAdminPlatformData(), refreshAdminUsers()] : [])
      ]);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function signInEmail({ email, password }) {
    setAuthError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ email, password })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const errorMessage = parseApiError(data, "Authentication failed");
        setAuthError(errorMessage);
        toast.error("Sign in failed", { description: errorMessage });
        return null;
      }

      toast.success("Signed in successfully");
      return refreshSession();
    } catch {
      setAuthError("Authentication request failed");
      toast.error("Sign in failed", { description: "Authentication request failed" });
      return null;
    }
  }

  async function signOut() {
    try {
      await fetch(`${apiBaseUrl}/api/auth/sign-out`, {
        method: "POST",
        credentials: "include"
      });
      setUser(null);
      toast.success("Signed out");
    } catch {
      toast.error("Sign out failed");
    }
  }

  async function updateUnitAssignment(unitId, agentId, options = {}) {
    const { refresh = true, suppressToast = false, successLabel = "Unit assignment updated" } = options;
    if (!unitId) {
      return { ok: false, error: "unitId_required" };
    }

    setApiError("");
    setMessage("");

    try {
      await request(`/api/units/${unitId}/assignment`, {
        method: "PUT",
        body: JSON.stringify({
          agentId: agentId || null
        })
      });

      setMessage(successLabel);
      if (!suppressToast) {
        toast.success(successLabel);
      }
      if (refresh) {
        await refreshData();
      }
      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setApiError(errorMessage);
      if (!suppressToast) {
        toast.error("Assignment update failed", { description: errorMessage });
      }
      return { ok: false, error: errorMessage };
    }
  }

  async function bulkUpdateUnitAssignments(unitIds, agentId, options = {}) {
    const uniqueUnitIds = Array.from(new Set((Array.isArray(unitIds) ? unitIds : []).filter(Boolean)));
    if (uniqueUnitIds.length === 0) {
      return { updated: 0, failed: 0, failures: [] };
    }

    const { successLabel = "Bulk assignment updated" } = options;
    setApiError("");
    setMessage("");

    const failures = [];
    let updated = 0;

    for (const unitId of uniqueUnitIds) {
      try {
        await request(`/api/units/${unitId}/assignment`, {
          method: "PUT",
          body: JSON.stringify({
            agentId: agentId || null
          })
        });
        updated += 1;
      } catch (error) {
        failures.push({
          unitId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await refreshData();

    if (updated > 0) {
      const summary = failures.length > 0
        ? `${successLabel}: ${updated} updated, ${failures.length} failed`
        : `${successLabel}: ${updated} updated`;
      setMessage(summary);
      toast.success(summary);
    }

    if (failures.length > 0) {
      const errorSummary = failures[0]?.error || "Bulk assignment failed for some rows";
      setApiError(errorSummary);
      toast.error("Bulk assignment partially failed", { description: errorSummary });
    }

    return {
      updated,
      failed: failures.length,
      failures
    };
  }

  async function saveAssignment(event) {
    event.preventDefault();

    if (!assignmentForm.unitId) {
      const errorMessage = "Select a listing first";
      setApiError(errorMessage);
      toast.error("Assignment update failed", { description: errorMessage });
      return;
    }

    await updateUnitAssignment(assignmentForm.unitId, assignmentForm.agentId || null, {
      refresh: true,
      suppressToast: false,
      successLabel: "Listing assignment updated"
    });
  }

  async function createDraft(event) {
    event.preventDefault();
    if (!selectedConversationId) {
      return;
    }

    setApiError("");
    setMessage("");
    try {
      const result = await request(`/api/inbox/${selectedConversationId}/draft`, {
        method: "POST",
        body: JSON.stringify({
          dispatchNow: true,
          body: draftForm.body || null
        })
      });
      const outcomeLabel = result.dispatched ? "Message sent to platform" : `Message ${result.status}`;
      setMessage(outcomeLabel);
      toast.success(result.dispatched ? "Reply sent" : "Draft processed", { description: outcomeLabel });
      setDraftForm((current) => ({ ...current, body: "" }));
      await Promise.all([refreshInbox(selectedInboxStatus), refreshConversationDetail(selectedConversationId)]);
    } catch (error) {
      setApiError(error.message);
      toast.error("Draft action failed", { description: error.message });
    }
  }

  async function updateConversationWorkflow(conversationId, updates, successLabel = "Workflow updated") {
    if (!conversationId) {
      return null;
    }

    setApiError("");
    setMessage("");
    try {
      const result = await request(`/api/conversations/${conversationId}/workflow-state`, {
        method: "POST",
        body: JSON.stringify(updates || {})
      });
      setMessage(successLabel);
      toast.success(successLabel);
      await Promise.all([
        refreshInbox(selectedInboxStatus),
        refreshConversationDetail(conversationId),
        refreshAppointments(appointmentFilters)
      ]);
      return result;
    } catch (error) {
      setApiError(error.message);
      toast.error("Workflow update failed", { description: error.message });
      return null;
    }
  }

  async function approveMessage(messageId) {
    setApiError("");
    setMessage("");
    try {
      await request(`/api/inbox/messages/${messageId}/approve`, { method: "POST" });
      setMessage("Message approved and sent");
      toast.success("Message approved and sent");
      await Promise.all([refreshInbox(selectedInboxStatus), refreshConversationDetail(selectedConversationId)]);
    } catch (error) {
      setApiError(error.message);
      toast.error("Approve action failed", { description: error.message });
    }
  }

  async function rejectMessage(messageId) {
    setApiError("");
    setMessage("");
    try {
      await request(`/api/inbox/messages/${messageId}/reject`, { method: "POST" });
      setMessage("Message moved to hold");
      toast.success("Message moved to hold");
      await Promise.all([refreshInbox(selectedInboxStatus), refreshConversationDetail(selectedConversationId)]);
    } catch (error) {
      setApiError(error.message);
      toast.error("Reject action failed", { description: error.message });
    }
  }

  useEffect(() => {
    refreshHealth();
    refreshSession();
  }, []);

  useEffect(() => {
    if (!user) {
      return;
    }
    refreshData();
  }, [user]);

  useEffect(() => {
    if (!user) {
      return;
    }
    refreshInbox(selectedInboxStatus, true, selectedInboxPlatform);
  }, [user, selectedInboxStatus, selectedInboxPlatform]);

  useEffect(() => {
    refreshConversationDetail(selectedConversationId);
  }, [selectedConversationId]);

  useEffect(() => {
    if (!user) {
      return;
    }
    const intervalMs = Number(import.meta.env.VITE_INBOX_POLL_INTERVAL_MS || 15000);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        await refreshInbox(selectedInboxStatus, true, selectedInboxPlatform);
        if (selectedConversationId) {
          await refreshConversationDetail(selectedConversationId);
        }
      } finally {
        inFlight = false;
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [user, selectedInboxStatus, selectedInboxPlatform, selectedConversationId]);

  const value = {
    apiBaseUrl,
    defaultPlatformAccountId,
    health,
    user,
    sessionLoading,
    authError,
    setAuthError,
    apiError,
    message,
    setMessage,
    isAdmin,
    canAccessAgent,
    agents,
    units,
    listings,
    selectedUnitId,
    setSelectedUnitId,
    availability,
    weeklyRules,
    assignmentForm,
    setAssignmentForm,
    selectedUnitListings,
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
    appointments,
    appointmentFilters,
    setAppointmentFilters,
    platformPolicies,
    platformHealth,
    globalPlatformSendMode,
    platformHealthGeneratedAt,
    adminUsers,
    userInvitations,
    refreshData,
    refreshInbox,
    refreshAvailability,
    refreshAppointments,
    refreshAdminPlatformData,
    refreshAdminUsers,
    signInEmail,
    signOut,
    createUserInvitation,
    revokeUserInvitation,
    verifyInvitationToken,
    acceptInvitationToken,
    saveAssignment,
    updateUnitAssignment,
    bulkUpdateUnitAssignments,
    createDraft,
    updateConversationWorkflow,
    approveMessage,
    rejectMessage,
    updatePlatformPolicy
  };

  return <LeaseBotContext.Provider value={value}>{children}</LeaseBotContext.Provider>;
}

export function useLeaseBot() {
  const context = useContext(LeaseBotContext);
  if (!context) {
    throw new Error("useLeaseBot must be used within LeaseBotProvider");
  }
  return context;
}
