import { useEffect, useMemo, useState } from "react";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
const defaultPlatformAccountId = "11111111-1111-1111-1111-111111111111";

function getPath() {
  return window.location.pathname || "/";
}

function navigate(path, replace = false) {
  if (replace) {
    window.history.replaceState({}, "", path);
  } else {
    window.history.pushState({}, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

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

function splitLocalDateTime(value) {
  const matched = String(value || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!matched) {
    return {
      date: "",
      time: ""
    };
  }
  return {
    date: matched[1],
    time: matched[2]
  };
}

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

const initialUnitForm = {
  id: "",
  propertyName: "",
  unitNumber: "",
  addressLine1: "",
  city: "",
  state: "",
  postalCode: "",
  bedrooms: "",
  bathrooms: "",
  squareFeet: "",
  isActive: true
};

const initialListingForm = {
  id: "",
  unitId: "",
  platformAccountId: defaultPlatformAccountId,
  listingExternalId: "",
  status: "active",
  rentCents: "",
  currencyCode: "USD",
  availableOn: "",
  assignedAgentId: ""
};

const initialWeeklyForm = {
  ruleId: "",
  dayOfWeek: "1",
  startTime: "09:00",
  endTime: "17:00",
  timezone: "America/New_York",
  fromDate: "",
  weeks: "8",
  listingId: "",
  notes: ""
};

const initialDailyForm = {
  slotId: "",
  date: "",
  startTime: "09:00",
  endTime: "09:30",
  timezone: "America/New_York",
  listingId: "",
  status: "open",
  notes: ""
};

const initialTemplateForm = {
  id: "",
  name: "tour_invite_v1",
  locale: "en-US",
  body: "Thanks for your interest in {{unit}}. The next open slot is {{slot}}.",
  variables: "unit,slot",
  isActive: true
};

export function App() {
  const [path, setPath] = useState(getPath());
  const [health, setHealth] = useState("loading");
  const [user, setUser] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [formMode, setFormMode] = useState("login");
  const [email, setEmail] = useState("agent@example.com");
  const [password, setPassword] = useState("password1234");
  const [name, setName] = useState("Agent User");
  const [authError, setAuthError] = useState("");
  const [apiError, setApiError] = useState("");
  const [message, setMessage] = useState("");

  const [agents, setAgents] = useState([]);
  const [units, setUnits] = useState([]);
  const [listings, setListings] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [weeklyRules, setWeeklyRules] = useState([]);
  const [inboxItems, setInboxItems] = useState([]);
  const [selectedInboxStatus, setSelectedInboxStatus] = useState("all");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [conversationDetail, setConversationDetail] = useState(null);
  const [automationState, setAutomationState] = useState({
    platformAccountId: defaultPlatformAccountId,
    autoSendEnabled: false,
    ruleId: null
  });
  const [observability, setObservability] = useState(null);
  const [observabilityControls, setObservabilityControls] = useState({
    windowHours: "24",
    auditLimit: "50",
    errorLimit: "25"
  });
  const [observabilityLoading, setObservabilityLoading] = useState(false);
  const [selectedUnitId, setSelectedUnitId] = useState("");

  const [unitForm, setUnitForm] = useState(initialUnitForm);
  const [listingForm, setListingForm] = useState(initialListingForm);
  const [assignmentForm, setAssignmentForm] = useState({ unitId: "", agentId: "", listingId: "" });
  const [weeklyForm, setWeeklyForm] = useState(initialWeeklyForm);
  const [dailyForm, setDailyForm] = useState(initialDailyForm);
  const [templateForm, setTemplateForm] = useState(initialTemplateForm);
  const [draftForm, setDraftForm] = useState({ templateId: "", body: "" });

  const isAdmin = user?.role === "admin";
  const canAccessAgent = user?.role === "agent" || isAdmin;
  const selectedUnitListings = useMemo(
    () => listings.filter((item) => item.unitId === selectedUnitId),
    [listings, selectedUnitId]
  );

  useEffect(() => {
    function onPopState() {
      setPath(getPath());
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchHealth() {
      try {
        const response = await fetch(`${apiBaseUrl}/health`, { signal: controller.signal });
        const data = await response.json();
        setHealth(data.status || "ok");
      } catch {
        setHealth("unreachable");
      }
    }

    fetchHealth();
    return () => controller.abort();
  }, []);

  async function requestApi(pathname, options = {}) {
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

  async function refreshData() {
    if (!user) {
      return;
    }

    setApiError("");
    try {
      const [agentsResponse, unitsResponse, listingsResponse] = await Promise.all([
        requestApi("/api/agents"),
        requestApi("/api/units"),
        requestApi("/api/listings")
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
      setListingForm((current) => ({
        ...current,
        unitId: current.unitId || fallbackUnitId,
        platformAccountId: current.platformAccountId || defaultPlatformAccountId
      }));

      await Promise.all([
        refreshAutomation(),
        refreshInbox(selectedInboxStatus, false),
        isAdmin ? refreshObservability() : Promise.resolve()
      ]);
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

    setApiError("");
    try {
      const [availabilityResponse, weeklyRulesResponse] = await Promise.all([
        requestApi(`/api/units/${unitId}/availability`),
        requestApi(`/api/units/${unitId}/availability/weekly-rules`)
      ]);

      setAvailability(availabilityResponse.items || []);
      setWeeklyRules(weeklyRulesResponse.items || []);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function refreshAutomation() {
    if (!user) {
      return;
    }

    try {
      const result = await requestApi(`/api/message-automation?platformAccountId=${defaultPlatformAccountId}`);
      setAutomationState(result);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function refreshObservability(overrideControls = null) {
    if (!user || !isAdmin) {
      return;
    }

    const controls = overrideControls || observabilityControls;
    const query = new URLSearchParams({
      windowHours: controls.windowHours || "24",
      auditLimit: controls.auditLimit || "50",
      errorLimit: controls.errorLimit || "25"
    });

    setObservabilityLoading(true);
    try {
      const result = await requestApi(`/api/admin/observability?${query.toString()}`);
      setObservability(result);
    } catch (error) {
      setApiError(error.message);
    } finally {
      setObservabilityLoading(false);
    }
  }

  async function refreshInbox(status = selectedInboxStatus, preserveSelection = true) {
    if (!user) {
      return;
    }

    try {
      const query = status && status !== "all" ? `?status=${status}` : "";
      const result = await requestApi(`/api/inbox${query}`);
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

  async function refreshConversationDetail(conversationId) {
    if (!conversationId) {
      setConversationDetail(null);
      return;
    }

    try {
      const result = await requestApi(`/api/inbox/${conversationId}`);
      setConversationDetail(result);
      if (!draftForm.templateId && result.templates?.[0]?.id) {
        setDraftForm((current) => ({ ...current, templateId: result.templates[0].id }));
      }
    } catch (error) {
      setApiError(error.message);
    }
  }

  useEffect(() => {
    refreshSession();
  }, []);

  useEffect(() => {
    if (sessionLoading) {
      return;
    }

    if (!user && path !== "/login") {
      navigate("/login", true);
      return;
    }

    if (user && path === "/login") {
      navigate(user.role === "admin" ? "/admin" : "/agent", true);
    }
  }, [path, sessionLoading, user]);

  useEffect(() => {
    if (!user) {
      return;
    }
    refreshData();
  }, [user]);

  useEffect(() => {
    refreshAvailability(selectedUnitId);
  }, [selectedUnitId]);

  useEffect(() => {
    if (!user) {
      return;
    }
    refreshInbox(selectedInboxStatus);
  }, [selectedInboxStatus, user]);

  useEffect(() => {
    refreshConversationDetail(selectedConversationId);
  }, [selectedConversationId]);

  async function submitAuth(event) {
    event.preventDefault();
    setAuthError("");

    const endpoint = formMode === "register" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
    const payload = formMode === "register" ? { email, password, name } : { email, password };

    try {
      const response = await fetch(`${apiBaseUrl}${endpoint}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setAuthError(parseApiError(data, "Authentication failed"));
        return;
      }

      const currentUser = await refreshSession();
      if (currentUser) {
        navigate(currentUser.role === "admin" ? "/admin" : "/agent", true);
      }
    } catch {
      setAuthError("Authentication request failed");
    }
  }

  async function signOut() {
    await fetch(`${apiBaseUrl}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include"
    });
    setUser(null);
    navigate("/login", true);
  }

  async function saveUnit(event) {
    event.preventDefault();
    setApiError("");
    setMessage("");

    const payload = {
      propertyName: unitForm.propertyName,
      unitNumber: unitForm.unitNumber,
      addressLine1: unitForm.addressLine1 || null,
      city: unitForm.city || null,
      state: unitForm.state || null,
      postalCode: unitForm.postalCode || null,
      bedrooms: unitForm.bedrooms ? Number(unitForm.bedrooms) : null,
      bathrooms: unitForm.bathrooms ? Number(unitForm.bathrooms) : null,
      squareFeet: unitForm.squareFeet ? Number(unitForm.squareFeet) : null,
      isActive: unitForm.isActive
    };

    try {
      if (unitForm.id) {
        await requestApi(`/api/units/${unitForm.id}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        setMessage("Unit updated");
      } else {
        await requestApi("/api/units", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        setMessage("Unit created");
      }

      setUnitForm(initialUnitForm);
      await refreshData();
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function deleteUnit(id) {
    setApiError("");
    setMessage("");
    try {
      await requestApi(`/api/units/${id}`, { method: "DELETE" });
      setMessage("Unit deleted");
      if (selectedUnitId === id) {
        setSelectedUnitId("");
      }
      setUnitForm(initialUnitForm);
      await refreshData();
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function saveListing(event) {
    event.preventDefault();
    setApiError("");
    setMessage("");

    const payload = {
      unitId: listingForm.unitId,
      platformAccountId: listingForm.platformAccountId,
      listingExternalId: listingForm.listingExternalId || null,
      status: listingForm.status,
      rentCents: Number(listingForm.rentCents),
      currencyCode: listingForm.currencyCode,
      availableOn: listingForm.availableOn || null,
      assignedAgentId: listingForm.assignedAgentId || null
    };

    try {
      if (listingForm.id) {
        await requestApi(`/api/listings/${listingForm.id}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        setMessage("Listing updated");
      } else {
        await requestApi("/api/listings", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        setMessage("Listing created");
      }

      setListingForm({ ...initialListingForm, unitId: selectedUnitId, platformAccountId: defaultPlatformAccountId });
      await refreshData();
      await refreshAvailability(selectedUnitId);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function deleteListing(id) {
    setApiError("");
    setMessage("");
    try {
      await requestApi(`/api/listings/${id}`, { method: "DELETE" });
      setMessage("Listing deleted");
      setListingForm({ ...initialListingForm, unitId: selectedUnitId, platformAccountId: defaultPlatformAccountId });
      await refreshData();
      await refreshAvailability(selectedUnitId);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function assignAgent(event) {
    event.preventDefault();
    setApiError("");
    setMessage("");

    try {
      await requestApi(`/api/units/${assignmentForm.unitId}/assignment`, {
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

  async function saveWeeklyRule(event) {
    event.preventDefault();
    setApiError("");
    setMessage("");

    const payload = {
      dayOfWeek: Number(weeklyForm.dayOfWeek),
      startTime: weeklyForm.startTime,
      endTime: weeklyForm.endTime,
      timezone: weeklyForm.timezone,
      fromDate: weeklyForm.fromDate || null,
      weeks: Number(weeklyForm.weeks),
      listingId: weeklyForm.listingId || null,
      notes: weeklyForm.notes || null
    };

    try {
      if (weeklyForm.ruleId) {
        await requestApi(`/api/units/${selectedUnitId}/availability/weekly-rules/${weeklyForm.ruleId}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        setMessage("Weekly recurring rule updated");
      } else {
        await requestApi(`/api/units/${selectedUnitId}/availability/weekly-rules`, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        setMessage("Weekly recurring rule created");
      }

      setWeeklyForm(initialWeeklyForm);
      await refreshAvailability(selectedUnitId);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function deleteWeeklyRule(ruleId) {
    setApiError("");
    setMessage("");
    try {
      await requestApi(`/api/units/${selectedUnitId}/availability/weekly-rules/${ruleId}`, { method: "DELETE" });
      setMessage("Weekly recurring rule deleted");
      setWeeklyForm(initialWeeklyForm);
      await refreshAvailability(selectedUnitId);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function saveDailyOverride(event) {
    event.preventDefault();
    setApiError("");
    setMessage("");

    const payload = {
      date: dailyForm.date,
      startTime: dailyForm.startTime,
      endTime: dailyForm.endTime,
      timezone: dailyForm.timezone,
      listingId: dailyForm.listingId || null,
      status: dailyForm.status,
      notes: dailyForm.notes || null
    };

    try {
      if (dailyForm.slotId) {
        await requestApi(`/api/availability/${dailyForm.slotId}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        setMessage("Daily override updated");
      } else {
        await requestApi(`/api/units/${selectedUnitId}/availability/daily-overrides`, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        setMessage("Daily override created");
      }

      setDailyForm(initialDailyForm);
      await refreshAvailability(selectedUnitId);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function deleteAvailabilitySlot(slotId) {
    setApiError("");
    setMessage("");
    try {
      await requestApi(`/api/availability/${slotId}`, { method: "DELETE" });
      setMessage("Availability slot deleted");
      setDailyForm(initialDailyForm);
      await refreshAvailability(selectedUnitId);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function toggleAutoSend() {
    setApiError("");
    setMessage("");

    try {
      const nextEnabled = !automationState.autoSendEnabled;
      const result = await requestApi("/api/message-automation", {
        method: "PUT",
        body: JSON.stringify({
          platformAccountId: defaultPlatformAccountId,
          enabled: nextEnabled
        })
      });
      setAutomationState((current) => ({ ...current, ...result }));
      setMessage(`Auto-send ${nextEnabled ? "enabled" : "disabled"}`);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function saveTemplate(event) {
    event.preventDefault();
    setApiError("");
    setMessage("");

    try {
      if (templateForm.id) {
        await requestApi(`/api/templates/${templateForm.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: templateForm.name,
            locale: templateForm.locale,
            body: templateForm.body,
            variables: templateForm.variables,
            isActive: templateForm.isActive
          })
        });
        setMessage("Template updated");
      } else {
        await requestApi("/api/templates", {
          method: "POST",
          body: JSON.stringify({
            platformAccountId: defaultPlatformAccountId,
            name: templateForm.name,
            locale: templateForm.locale,
            body: templateForm.body,
            variables: templateForm.variables,
            isActive: templateForm.isActive
          })
        });
        setMessage("Template created");
      }

      await refreshConversationDetail(selectedConversationId);
      setTemplateForm(initialTemplateForm);
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
      const result = await requestApi(`/api/inbox/${selectedConversationId}/draft`, {
        method: "POST",
        body: JSON.stringify({
          templateId: draftForm.templateId || null,
          body: draftForm.body || null
        })
      });
      setMessage(`Message ${result.status}`);
      setDraftForm({ templateId: draftForm.templateId, body: "" });
      await Promise.all([
        refreshInbox(selectedInboxStatus),
        refreshConversationDetail(selectedConversationId)
      ]);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function approveMessage(messageId) {
    setApiError("");
    setMessage("");
    try {
      await requestApi(`/api/inbox/messages/${messageId}/approve`, { method: "POST" });
      setMessage("Message approved and sent");
      await Promise.all([
        refreshInbox(selectedInboxStatus),
        refreshConversationDetail(selectedConversationId)
      ]);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function rejectMessage(messageId) {
    setApiError("");
    setMessage("");
    try {
      await requestApi(`/api/inbox/messages/${messageId}/reject`, { method: "POST" });
      setMessage("Message moved to hold");
      await Promise.all([
        refreshInbox(selectedInboxStatus),
        refreshConversationDetail(selectedConversationId)
      ]);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function submitObservabilityFilters(event) {
    event.preventDefault();
    await refreshObservability();
  }

  if (sessionLoading) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
        <h1>Lease Bot</h1>
        <p>Loading session...</p>
      </main>
    );
  }

  if (!user || path === "/login") {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: "36rem" }}>
        <h1>Lease Bot Login</h1>
        <p>API health: {health}</p>
        <p>API base URL: {apiBaseUrl}</p>

        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <button type="button" onClick={() => setFormMode("login")} disabled={formMode === "login"}>Login</button>
          <button type="button" onClick={() => setFormMode("register")} disabled={formMode === "register"}>Register</button>
        </div>

        <form onSubmit={submitAuth} style={{ display: "grid", gap: "0.75rem" }}>
          {formMode === "register" ? (
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} required style={{ display: "block", width: "100%" }} />
            </label>
          ) : null}

          <label>
            Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required style={{ display: "block", width: "100%" }} />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
              style={{ display: "block", width: "100%" }}
            />
          </label>

          <button type="submit">{formMode === "register" ? "Create account" : "Sign in"}</button>
        </form>

        {authError ? <p style={{ color: "crimson" }}>{authError}</p> : null}
      </main>
    );
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: "74rem" }}>
      <h1>Lease Bot</h1>
      <p>Logged in as {user.email} ({user.role})</p>
      <p>API health: {health}</p>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button type="button" onClick={() => navigate("/agent")}>Agent area</button>
        <button type="button" onClick={() => navigate("/admin")}>Admin area</button>
        <button type="button" onClick={refreshData}>Refresh data</button>
        <button type="button" onClick={signOut}>Sign out</button>
      </div>

      {message ? <p style={{ color: "seagreen" }}>{message}</p> : null}
      {apiError ? <p style={{ color: "crimson" }}>{apiError}</p> : null}

      {path === "/agent" && canAccessAgent ? (
        <section>
          <h2>Agent View</h2>
          <p>Read-only inventory snapshot.</p>
          <pre>{JSON.stringify({ units: units.slice(0, 5), listings: listings.slice(0, 5) }, null, 2)}</pre>
        </section>
      ) : null}

      {path === "/admin" && !isAdmin ? (
        <section>
          <h2>Admin Protected Route</h2>
          <p style={{ color: "crimson" }}>403: your role does not allow admin access.</p>
        </section>
      ) : null}

      {path === "/admin" && isAdmin ? (
        <>
          <section style={{ marginTop: "1.5rem" }}>
            <h2>Observability</h2>
            <p>Core messaging metrics, recent errors, and audit timeline.</p>

            <form
              onSubmit={submitObservabilityFilters}
              style={{ display: "flex", gap: "0.5rem", alignItems: "end", flexWrap: "wrap", marginBottom: "0.75rem" }}
            >
              <label>
                Window hours
                <input
                  value={observabilityControls.windowHours}
                  onChange={(event) =>
                    setObservabilityControls((current) => ({ ...current, windowHours: event.target.value.replace(/\D/g, "") }))
                  }
                  inputMode="numeric"
                  style={{ display: "block" }}
                />
              </label>
              <label>
                Audit rows
                <input
                  value={observabilityControls.auditLimit}
                  onChange={(event) =>
                    setObservabilityControls((current) => ({ ...current, auditLimit: event.target.value.replace(/\D/g, "") }))
                  }
                  inputMode="numeric"
                  style={{ display: "block" }}
                />
              </label>
              <label>
                Error rows
                <input
                  value={observabilityControls.errorLimit}
                  onChange={(event) =>
                    setObservabilityControls((current) => ({ ...current, errorLimit: event.target.value.replace(/\D/g, "") }))
                  }
                  inputMode="numeric"
                  style={{ display: "block" }}
                />
              </label>
              <button type="submit" disabled={observabilityLoading}>
                {observabilityLoading ? "Loading..." : "Refresh observability"}
              </button>
            </form>

            {observability ? (
              <>
                <p>Window: last {observability.windowHours} hour(s).</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))", gap: "0.5rem" }}>
                  {Object.entries(observability.coreMetrics || {}).map(([key, value]) => (
                    <div key={key} style={{ border: "1px solid #ddd", borderRadius: "0.4rem", padding: "0.5rem" }}>
                      <div style={{ fontSize: "0.85rem", color: "#444" }}>{key}</div>
                      <div style={{ fontSize: "1.25rem", fontWeight: "bold" }}>{value}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))", gap: "1rem", marginTop: "1rem" }}>
                  <div>
                    <h3>Recent errors</h3>
                    {(observability.recentErrors || []).length === 0 ? (
                      <p>No recent errors.</p>
                    ) : (
                      <ul>
                        {(observability.recentErrors || []).map((item) => (
                          <li key={item.id}>
                            <strong>{item.action}</strong> - {item.entityType}:{item.entityId} - {formatTimestamp(item.createdAt)}
                            <div>{JSON.stringify(item.details || {})}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h3>Recent audit trail</h3>
                    {(observability.recentAudit || []).length === 0 ? (
                      <p>No audit records yet.</p>
                    ) : (
                      <ul>
                        {(observability.recentAudit || []).map((item) => (
                          <li key={item.id}>
                            <strong>{item.action}</strong> - {item.entityType}:{item.entityId} - {formatTimestamp(item.createdAt)}
                            <div>actor: {item.actorType}{item.actorId ? ` (${item.actorId})` : ""}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p>No observability snapshot loaded yet.</p>
            )}
          </section>

          <section style={{ marginTop: "1.5rem" }}>
            <h2>Units CRUD</h2>
            <form onSubmit={saveUnit} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "0.5rem" }}>
              <input placeholder="Property" value={unitForm.propertyName} onChange={(event) => setUnitForm((current) => ({ ...current, propertyName: event.target.value }))} required />
              <input placeholder="Unit #" value={unitForm.unitNumber} onChange={(event) => setUnitForm((current) => ({ ...current, unitNumber: event.target.value }))} required />
              <input placeholder="Address" value={unitForm.addressLine1} onChange={(event) => setUnitForm((current) => ({ ...current, addressLine1: event.target.value }))} />
              <input placeholder="City" value={unitForm.city} onChange={(event) => setUnitForm((current) => ({ ...current, city: event.target.value }))} />
              <input placeholder="State" value={unitForm.state} onChange={(event) => setUnitForm((current) => ({ ...current, state: event.target.value }))} />
              <input placeholder="Postal" value={unitForm.postalCode} onChange={(event) => setUnitForm((current) => ({ ...current, postalCode: event.target.value }))} />
              <input placeholder="Beds" value={unitForm.bedrooms} onChange={(event) => setUnitForm((current) => ({ ...current, bedrooms: event.target.value }))} />
              <input placeholder="Baths" value={unitForm.bathrooms} onChange={(event) => setUnitForm((current) => ({ ...current, bathrooms: event.target.value }))} />
              <input placeholder="Square feet" value={unitForm.squareFeet} onChange={(event) => setUnitForm((current) => ({ ...current, squareFeet: event.target.value }))} />
              <label>
                Active
                <input type="checkbox" checked={unitForm.isActive} onChange={(event) => setUnitForm((current) => ({ ...current, isActive: event.target.checked }))} />
              </label>
              <button type="submit">{unitForm.id ? "Update unit" : "Create unit"}</button>
              <button type="button" onClick={() => setUnitForm(initialUnitForm)}>Clear</button>
            </form>

            <ul>
              {units.map((item) => (
                <li key={item.id}>
                  <strong>{item.propertyName} {item.unitNumber}</strong> - {item.city || "n/a"} - assigned: {item.assignedAgentId || "none"}
                  <button type="button" onClick={() => {
                    setUnitForm({
                      id: item.id,
                      propertyName: item.propertyName,
                      unitNumber: item.unitNumber,
                      addressLine1: item.addressLine1 || "",
                      city: item.city || "",
                      state: item.state || "",
                      postalCode: item.postalCode || "",
                      bedrooms: item.bedrooms ?? "",
                      bathrooms: item.bathrooms ?? "",
                      squareFeet: item.squareFeet ?? "",
                      isActive: item.isActive
                    });
                    setSelectedUnitId(item.id);
                  }}>Edit</button>
                  <button type="button" onClick={() => deleteUnit(item.id)}>Delete</button>
                </li>
              ))}
            </ul>
          </section>

          <section style={{ marginTop: "1.5rem" }}>
            <h2>Unit to Agent Assignment</h2>
            <form onSubmit={assignAgent} style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <select value={assignmentForm.unitId} onChange={(event) => setAssignmentForm((current) => ({ ...current, unitId: event.target.value }))} required>
                <option value="">Select unit</option>
                {units.map((item) => <option key={item.id} value={item.id}>{item.propertyName} {item.unitNumber}</option>)}
              </select>

              <select value={assignmentForm.listingId} onChange={(event) => setAssignmentForm((current) => ({ ...current, listingId: event.target.value }))}>
                <option value="">Latest listing for unit</option>
                {listings.filter((item) => item.unitId === assignmentForm.unitId).map((item) => (
                  <option key={item.id} value={item.id}>{item.id.slice(0, 8)} ({item.status})</option>
                ))}
              </select>

              <select value={assignmentForm.agentId} onChange={(event) => setAssignmentForm((current) => ({ ...current, agentId: event.target.value }))}>
                <option value="">Unassign</option>
                {agents.map((item) => <option key={item.id} value={item.id}>{item.fullName}</option>)}
              </select>
              <button type="submit">Save assignment</button>
            </form>
          </section>

          <section style={{ marginTop: "1.5rem" }}>
            <h2>Listings CRUD</h2>
            <form onSubmit={saveListing} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "0.5rem" }}>
              <select value={listingForm.unitId} onChange={(event) => setListingForm((current) => ({ ...current, unitId: event.target.value }))} required>
                <option value="">Select unit</option>
                {units.map((item) => <option key={item.id} value={item.id}>{item.propertyName} {item.unitNumber}</option>)}
              </select>
              <input placeholder="Platform account UUID" value={listingForm.platformAccountId} onChange={(event) => setListingForm((current) => ({ ...current, platformAccountId: event.target.value }))} required />
              <input placeholder="Listing external id" value={listingForm.listingExternalId} onChange={(event) => setListingForm((current) => ({ ...current, listingExternalId: event.target.value }))} />
              <input placeholder="Rent cents" value={listingForm.rentCents} onChange={(event) => setListingForm((current) => ({ ...current, rentCents: event.target.value }))} required />
              <input placeholder="Currency" value={listingForm.currencyCode} onChange={(event) => setListingForm((current) => ({ ...current, currencyCode: event.target.value.toUpperCase() }))} />
              <input type="date" value={listingForm.availableOn} onChange={(event) => setListingForm((current) => ({ ...current, availableOn: event.target.value }))} />
              <select value={listingForm.status} onChange={(event) => setListingForm((current) => ({ ...current, status: event.target.value }))}>
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="leased">leased</option>
                <option value="draft">draft</option>
              </select>
              <select value={listingForm.assignedAgentId} onChange={(event) => setListingForm((current) => ({ ...current, assignedAgentId: event.target.value }))}>
                <option value="">No assigned agent</option>
                {agents.map((item) => <option key={item.id} value={item.id}>{item.fullName}</option>)}
              </select>
              <button type="submit">{listingForm.id ? "Update listing" : "Create listing"}</button>
              <button type="button" onClick={() => setListingForm({ ...initialListingForm, unitId: selectedUnitId, platformAccountId: defaultPlatformAccountId })}>Clear</button>
            </form>

            <ul>
              {listings.map((item) => (
                <li key={item.id}>
                  <strong>{item.id.slice(0, 8)}</strong> - unit {item.unitId.slice(0, 8)} - rent {item.rentCents} - assigned {item.assignedAgentId || "none"}
                  <button type="button" onClick={() => {
                    setListingForm({
                      id: item.id,
                      unitId: item.unitId,
                      platformAccountId: item.platformAccountId,
                      listingExternalId: item.listingExternalId || "",
                      status: item.status,
                      rentCents: String(item.rentCents),
                      currencyCode: item.currencyCode,
                      availableOn: item.availableOn || "",
                      assignedAgentId: item.assignedAgentId || ""
                    });
                    setSelectedUnitId(item.unitId);
                  }}>Edit</button>
                  <button type="button" onClick={() => deleteListing(item.id)}>Delete</button>
                </li>
              ))}
            </ul>
          </section>

          <section style={{ marginTop: "1.5rem" }}>
            <h2>Availability Management</h2>
            <label>
              Unit
              <select value={selectedUnitId} onChange={(event) => setSelectedUnitId(event.target.value)}>
                <option value="">Select unit</option>
                {units.map((item) => <option key={item.id} value={item.id}>{item.propertyName} {item.unitNumber}</option>)}
              </select>
            </label>

            {selectedUnitId ? (
              <>
                <h3>Weekly Recurring (create/read/update/delete)</h3>
                <form onSubmit={saveWeeklyRule} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "0.5rem" }}>
                  <select value={weeklyForm.dayOfWeek} onChange={(event) => setWeeklyForm((current) => ({ ...current, dayOfWeek: event.target.value }))}>
                    <option value="0">Sunday</option>
                    <option value="1">Monday</option>
                    <option value="2">Tuesday</option>
                    <option value="3">Wednesday</option>
                    <option value="4">Thursday</option>
                    <option value="5">Friday</option>
                    <option value="6">Saturday</option>
                  </select>
                  <input type="time" value={weeklyForm.startTime} onChange={(event) => setWeeklyForm((current) => ({ ...current, startTime: event.target.value }))} required />
                  <input type="time" value={weeklyForm.endTime} onChange={(event) => setWeeklyForm((current) => ({ ...current, endTime: event.target.value }))} required />
                  <input placeholder="Timezone" value={weeklyForm.timezone} onChange={(event) => setWeeklyForm((current) => ({ ...current, timezone: event.target.value }))} required />
                  <input type="date" value={weeklyForm.fromDate} onChange={(event) => setWeeklyForm((current) => ({ ...current, fromDate: event.target.value }))} />
                  <input placeholder="Weeks" value={weeklyForm.weeks} onChange={(event) => setWeeklyForm((current) => ({ ...current, weeks: event.target.value }))} required />
                  <select value={weeklyForm.listingId} onChange={(event) => setWeeklyForm((current) => ({ ...current, listingId: event.target.value }))}>
                    <option value="">No listing</option>
                    {selectedUnitListings.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)}</option>)}
                  </select>
                  <input placeholder="Notes" value={weeklyForm.notes} onChange={(event) => setWeeklyForm((current) => ({ ...current, notes: event.target.value }))} />
                  <button type="submit">{weeklyForm.ruleId ? "Update recurring rule" : "Create recurring rule"}</button>
                  <button type="button" onClick={() => setWeeklyForm(initialWeeklyForm)}>Clear</button>
                </form>

                <ul>
                  {weeklyRules.map((item) => (
                    <li key={item.ruleId}>
                      <strong>{item.ruleId.slice(0, 8)}</strong> - {item.timezone} - occurrences {item.occurrences.length}
                      <button type="button" onClick={() => {
                        const first = item.occurrences[0];
                        const split = splitLocalDateTime(first?.localStart);
                        const splitEnd = splitLocalDateTime(first?.localEnd);
                        setWeeklyForm({
                          ruleId: item.ruleId,
                          dayOfWeek: String(new Date(`${split.date || "1970-01-01"}T00:00:00.000Z`).getUTCDay()),
                          startTime: split.time || "09:00",
                          endTime: splitEnd.time || "17:00",
                          timezone: item.timezone,
                          fromDate: split.date || "",
                          weeks: String(item.occurrences.length || 8),
                          listingId: item.listingId || "",
                          notes: item.notes || ""
                        });
                      }}>Edit</button>
                      <button type="button" onClick={() => deleteWeeklyRule(item.ruleId)}>Delete</button>
                    </li>
                  ))}
                </ul>

                <h3>Daily Override (create/read/update/delete)</h3>
                <form onSubmit={saveDailyOverride} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "0.5rem" }}>
                  <input type="date" value={dailyForm.date} onChange={(event) => setDailyForm((current) => ({ ...current, date: event.target.value }))} required />
                  <input type="time" value={dailyForm.startTime} onChange={(event) => setDailyForm((current) => ({ ...current, startTime: event.target.value }))} required />
                  <input type="time" value={dailyForm.endTime} onChange={(event) => setDailyForm((current) => ({ ...current, endTime: event.target.value }))} required />
                  <input placeholder="Timezone" value={dailyForm.timezone} onChange={(event) => setDailyForm((current) => ({ ...current, timezone: event.target.value }))} required />
                  <select value={dailyForm.listingId} onChange={(event) => setDailyForm((current) => ({ ...current, listingId: event.target.value }))}>
                    <option value="">No listing</option>
                    {selectedUnitListings.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)}</option>)}
                  </select>
                  <select value={dailyForm.status} onChange={(event) => setDailyForm((current) => ({ ...current, status: event.target.value }))}>
                    <option value="open">open</option>
                    <option value="blocked">blocked</option>
                  </select>
                  <input placeholder="Notes" value={dailyForm.notes} onChange={(event) => setDailyForm((current) => ({ ...current, notes: event.target.value }))} />
                  <button type="submit">{dailyForm.slotId ? "Update daily override" : "Create daily override"}</button>
                  <button type="button" onClick={() => setDailyForm(initialDailyForm)}>Clear</button>
                </form>

                <ul>
                  {availability.map((item) => (
                    <li key={item.id}>
                      <strong>{item.source}</strong> - {item.localStart} to {item.localEnd} ({item.displayTimezone})
                      <button
                        type="button"
                        onClick={() => {
                          const split = splitLocalDateTime(item.localStart);
                          const splitEnd = splitLocalDateTime(item.localEnd);
                          setDailyForm({
                            slotId: item.id,
                            date: split.date,
                            startTime: split.time,
                            endTime: splitEnd.time,
                            timezone: item.timezone,
                            listingId: item.listingId || "",
                            status: item.status || "open",
                            notes: item.notes || ""
                          });
                        }}
                      >
                        Edit as override
                      </button>
                      <button type="button" onClick={() => deleteAvailabilitySlot(item.id)}>Delete</button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          <section style={{ marginTop: "1.5rem" }}>
            <h2>Inbox + Templates + Approval</h2>
            <p>Status flow: new, draft, sent, hold.</p>

            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.75rem" }}>
              <label>
                Filter
                <select value={selectedInboxStatus} onChange={(event) => setSelectedInboxStatus(event.target.value)}>
                  <option value="all">all</option>
                  <option value="new">new</option>
                  <option value="draft">draft</option>
                  <option value="sent">sent</option>
                  <option value="hold">hold</option>
                </select>
              </label>
              <button type="button" onClick={() => refreshInbox(selectedInboxStatus, false)}>Refresh inbox</button>
              <button type="button" onClick={toggleAutoSend}>
                Auto-send: {automationState.autoSendEnabled ? "ON" : "OFF"}
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(18rem, 22rem) 1fr", gap: "1rem" }}>
              <div>
                <h3>Inbox list</h3>
                <ul>
                  {inboxItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedConversationId(item.id)}
                        style={{ fontWeight: selectedConversationId === item.id ? "bold" : "normal" }}
                      >
                        {item.leadName || item.externalThreadId} - {item.messageStatus}
                      </button>
                      <div>{item.unit || "No unit"}</div>
                      <div>Latest: {item.latestMessage || "n/a"}</div>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3>Conversation detail</h3>
                {conversationDetail ? (
                  <>
                    <p>
                      <strong>{conversationDetail.conversation.leadName || "Unknown lead"}</strong>
                      {" "}- unit: {conversationDetail.conversation.unit || "n/a"}
                    </p>
                    <p>Template variables: unit={conversationDetail.templateContext?.unit || ""} | slot={conversationDetail.templateContext?.slot || ""}</p>

                    <ul>
                      {(conversationDetail.messages || []).map((item) => (
                        <li key={item.id}>
                          <strong>{item.direction}</strong> [{item.status}] {item.body}
                          {item.status === "draft" ? (
                            <>
                              <button type="button" onClick={() => approveMessage(item.id)}>Approve</button>
                              <button type="button" onClick={() => rejectMessage(item.id)}>Reject</button>
                            </>
                          ) : null}
                          {item.status === "hold" ? (
                            <button type="button" onClick={() => approveMessage(item.id)}>Approve</button>
                          ) : null}
                        </li>
                      ))}
                    </ul>

                    <h4>Create draft / auto-send message</h4>
                    <form onSubmit={createDraft} style={{ display: "grid", gap: "0.5rem" }}>
                      <select
                        value={draftForm.templateId}
                        onChange={(event) => {
                          const templateId = event.target.value;
                          const template = (conversationDetail.templates || []).find((item) => item.id === templateId);
                          setDraftForm((current) => ({ ...current, templateId, body: template ? template.body : current.body }));
                        }}
                      >
                        <option value="">No template</option>
                        {(conversationDetail.templates || []).map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                      <textarea
                        placeholder="Optional manual body"
                        value={draftForm.body}
                        onChange={(event) => setDraftForm((current) => ({ ...current, body: event.target.value }))}
                        rows={3}
                      />
                      <button type="submit">Create draft / send</button>
                    </form>

                    <h4>Template editor</h4>
                    <form onSubmit={saveTemplate} style={{ display: "grid", gap: "0.5rem" }}>
                      <input
                        placeholder="Template name"
                        value={templateForm.name}
                        onChange={(event) => setTemplateForm((current) => ({ ...current, name: event.target.value }))}
                        required
                      />
                      <input
                        placeholder="Locale"
                        value={templateForm.locale}
                        onChange={(event) => setTemplateForm((current) => ({ ...current, locale: event.target.value }))}
                        required
                      />
                      <input
                        placeholder="Variables (comma separated)"
                        value={templateForm.variables}
                        onChange={(event) => setTemplateForm((current) => ({ ...current, variables: event.target.value }))}
                      />
                      <textarea
                        placeholder="Template body"
                        value={templateForm.body}
                        onChange={(event) => setTemplateForm((current) => ({ ...current, body: event.target.value }))}
                        rows={3}
                        required
                      />
                      <label>
                        Active
                        <input
                          type="checkbox"
                          checked={templateForm.isActive}
                          onChange={(event) => setTemplateForm((current) => ({ ...current, isActive: event.target.checked }))}
                        />
                      </label>
                      <button type="submit">Save template</button>
                    </form>

                    <ul>
                      {(conversationDetail.templates || []).map((item) => (
                        <li key={item.id}>
                          <strong>{item.name}</strong> ({item.locale}) [{item.isActive ? "active" : "inactive"}] vars: {(item.variables || []).join(",")}
                          <button
                            type="button"
                            onClick={() =>
                              setTemplateForm({
                                id: item.id,
                                name: item.name,
                                locale: item.locale,
                                body: item.body,
                                variables: (item.variables || []).join(","),
                                isActive: item.isActive
                              })
                            }
                          >
                            Edit
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>Select a conversation from inbox list.</p>
                )}
              </div>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
