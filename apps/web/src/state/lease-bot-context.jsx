import { createContext, useContext, useEffect, useMemo, useState } from "react";

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
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [conversationDetail, setConversationDetail] = useState(null);
  const [draftForm, setDraftForm] = useState({ templateId: "", body: "" });
  const [appointments, setAppointments] = useState([]);
  const [appointmentFilters, setAppointmentFilters] = useState({
    status: "all",
    unitId: "all",
    fromDate: "",
    toDate: ""
  });

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
      if (!draftForm.templateId && result.templates?.[0]?.id) {
        setDraftForm((current) => ({ ...current, templateId: result.templates[0].id }));
      }
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function refreshInbox(status = selectedInboxStatus, preserveSelection = true) {
    if (!user) {
      return;
    }

    try {
      const query = status && status !== "all" ? `?status=${status}` : "";
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
      setSelectedUnitId((current) => current || fallbackUnitId);
      setAssignmentForm((current) => ({
        ...current,
        unitId: current.unitId || fallbackUnitId
      }));

      await Promise.all([refreshInbox(selectedInboxStatus, false), refreshAvailability(fallbackUnitId), refreshAppointments()]);
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
        setAuthError(parseApiError(data, "Authentication failed"));
        return null;
      }

      return refreshSession();
    } catch {
      setAuthError("Authentication request failed");
      return null;
    }
  }

  async function signUpEmail({ email, password, name }) {
    setAuthError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/sign-up/email`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ email, password, name })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setAuthError(parseApiError(data, "Registration failed"));
        return null;
      }

      return refreshSession();
    } catch {
      setAuthError("Registration request failed");
      return null;
    }
  }

  async function signOut() {
    await fetch(`${apiBaseUrl}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include"
    });
    setUser(null);
  }

  async function saveAssignment(event) {
    event.preventDefault();
    setApiError("");
    setMessage("");

    try {
      await request(`/api/units/${assignmentForm.unitId}/assignment`, {
        method: "PUT",
        body: JSON.stringify({
          agentId: assignmentForm.agentId || null,
          listingId: assignmentForm.listingId || null
        })
      });
      setMessage("Unit assignment updated");
      await refreshData();
    } catch (error) {
      setApiError(error.message);
    }
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
          templateId: draftForm.templateId || null,
          body: draftForm.body || null
        })
      });
      setMessage(`Message ${result.status}`);
      setDraftForm((current) => ({ ...current, body: "" }));
      await Promise.all([refreshInbox(selectedInboxStatus), refreshConversationDetail(selectedConversationId)]);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function approveMessage(messageId) {
    setApiError("");
    setMessage("");
    try {
      await request(`/api/inbox/messages/${messageId}/approve`, { method: "POST" });
      setMessage("Message approved and sent");
      await Promise.all([refreshInbox(selectedInboxStatus), refreshConversationDetail(selectedConversationId)]);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function rejectMessage(messageId) {
    setApiError("");
    setMessage("");
    try {
      await request(`/api/inbox/messages/${messageId}/reject`, { method: "POST" });
      setMessage("Message moved to hold");
      await Promise.all([refreshInbox(selectedInboxStatus), refreshConversationDetail(selectedConversationId)]);
    } catch (error) {
      setApiError(error.message);
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
    refreshConversationDetail(selectedConversationId);
  }, [selectedConversationId]);

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
    selectedConversationId,
    setSelectedConversationId,
    conversationDetail,
    draftForm,
    setDraftForm,
    appointments,
    appointmentFilters,
    setAppointmentFilters,
    refreshData,
    refreshInbox,
    refreshAvailability,
    refreshAppointments,
    signInEmail,
    signUpEmail,
    signOut,
    saveAssignment,
    createDraft,
    approveMessage,
    rejectMessage
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
