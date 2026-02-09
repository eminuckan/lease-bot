import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
const defaultPlatformAccountId = "11111111-1111-1111-1111-111111111111";
const inboxPollIntervalMs = Number(import.meta.env.VITE_INBOX_POLL_INTERVAL_MS || 15000);
const inboxCacheTtlMs = Number(import.meta.env.VITE_INBOX_CACHE_TTL_MS || 10000);
const conversationCacheTtlMs = Number(import.meta.env.VITE_CONVERSATION_CACHE_TTL_MS || 12000);
const conversationThreadSyncRetryMs = Number(import.meta.env.VITE_CONVERSATION_THREAD_SYNC_RETRY_MS || 60000);
const conversationThreadSyncSuccessCooldownMs = Number(import.meta.env.VITE_CONVERSATION_THREAD_SYNC_SUCCESS_COOLDOWN_MS || 300000);
const conversationPrefetchCount = Number(import.meta.env.VITE_CONVERSATION_PREFETCH_COUNT || 6);
const conversationPrefetchTtlMs = Number(import.meta.env.VITE_CONVERSATION_PREFETCH_TTL_MS || 45000);
const listingsCacheTtlMs = Number(import.meta.env.VITE_LISTINGS_CACHE_TTL_MS || 180000);
const listingsPollIntervalMs = Number(import.meta.env.VITE_LISTINGS_POLL_INTERVAL_MS || 180000);

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

function isFresh(cacheTimestamp, ttlMs) {
  return Number.isFinite(cacheTimestamp)
    && Number.isFinite(ttlMs)
    && ttlMs > 0
    && Date.now() - cacheTimestamp <= ttlMs;
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
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxLastFetchedAt, setInboxLastFetchedAt] = useState(null);
  const [selectedInboxStatus, setSelectedInboxStatus] = useState("all");
  const [selectedInboxPlatform, setSelectedInboxPlatform] = useState("all");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [conversationDetail, setConversationDetail] = useState(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationRefreshing, setConversationRefreshing] = useState(false);
  const [draftForm, setDraftForm] = useState({ body: "" });
  const [syncedConversations, setSyncedConversations] = useState({});
  const [appointments, setAppointments] = useState([]);
  const [listingsLoading, setListingsLoading] = useState(false);
  const [listingsLastFetchedAt, setListingsLastFetchedAt] = useState(null);
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
  const sessionRequestSeq = useRef(0);
  const inboxRequestSeq = useRef(0);
  const conversationRequestSeq = useRef(0);
  const inboxCacheRef = useRef(new Map());
  const conversationCacheRef = useRef(new Map());
  const conversationPrefetchInFlightRef = useRef(new Set());
  const conversationSyncInFlightRef = useRef(new Set());
  const listingsCacheRef = useRef({ items: [], fetchedAt: 0 });

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
    const requestId = sessionRequestSeq.current + 1;
    sessionRequestSeq.current = requestId;
    setSessionLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/me`, { credentials: "include" });
      if (requestId !== sessionRequestSeq.current) {
        return null;
      }
      if (!response.ok) {
        setUser(null);
        return null;
      }

      const data = await response.json();
      if (requestId !== sessionRequestSeq.current) {
        return null;
      }
      setUser(data.user || null);
      return data.user || null;
    } catch {
      if (requestId !== sessionRequestSeq.current) {
        return null;
      }
      setUser(null);
      return null;
    } finally {
      if (requestId === sessionRequestSeq.current) {
        setSessionLoading(false);
      }
    }
  }

  function applyInboxItems(items, preserveSelection) {
    setInboxItems(items);
    setSelectedConversationId((current) => {
      if (preserveSelection && current && items.some((item) => item.id === current)) {
        return current;
      }
      return items[0]?.id || "";
    });
  }

  function shouldAutoSyncConversationThread(conversationId, detail) {
    const platform = detail?.conversation?.platform;
    if (platform !== "spareroom") {
      return false;
    }

    const messages = Array.isArray(detail?.messages) ? detail.messages : [];
    const threadMessageCount = Number(detail?.conversation?.threadMessageCount);
    const threadMessages = messages.filter((item) => item?.metadata?.sentAtSource === "platform_thread");
    const syncState = syncedConversations[conversationId];
    const nowMs = Date.now();
    const hasKnownThreadGap = Number.isFinite(threadMessageCount) && threadMessageCount > threadMessages.length;
    const hasNoThreadHistory = threadMessages.length === 0;
    const canRetrySync = !syncState?.nextRetryAt || nowMs >= syncState.nextRetryAt;
    const syncedRecently = Number.isFinite(syncState?.lastSyncedAt)
      && nowMs - syncState.lastSyncedAt < conversationThreadSyncSuccessCooldownMs;

    return !syncedRecently && !syncState?.inFlight && canRetrySync && (hasNoThreadHistory || hasKnownThreadGap);
  }

  async function runConversationThreadSync(conversationId, requestId = null) {
    if (!conversationId) {
      return;
    }

    if (conversationSyncInFlightRef.current.has(conversationId)) {
      return;
    }

    const syncState = syncedConversations[conversationId];
    if (syncState?.inFlight) {
      return;
    }
    if (syncState?.nextRetryAt && Date.now() < syncState.nextRetryAt) {
      return;
    }

    conversationSyncInFlightRef.current.add(conversationId);
    setSyncedConversations((current) => ({
      ...current,
      [conversationId]: {
        ...(current[conversationId] || {}),
        inFlight: true
      }
    }));

    try {
      const synced = await request(`/api/inbox/${conversationId}/sync`, { method: "POST" });
      const syncedAt = Date.now();
      conversationCacheRef.current.set(conversationId, { detail: synced, fetchedAt: syncedAt });

      const syncedThreadMessageCount = Number(synced?.conversation?.threadMessageCount);
      const syncedMessages = Array.isArray(synced?.messages) ? synced.messages : [];
      const syncedThreadMessages = syncedMessages.filter((item) => item?.metadata?.sentAtSource === "platform_thread");

      if (requestId === null || requestId === conversationRequestSeq.current) {
        setConversationDetail((current) => {
          if (!current || current?.conversation?.id !== conversationId) {
            return current;
          }
          return synced;
        });
      }

      setSyncedConversations((current) => ({
        ...current,
        [conversationId]: {
          inFlight: false,
          nextRetryAt: null,
          lastSyncedAt: syncedAt,
          threadMessageCount: Number.isFinite(syncedThreadMessageCount)
            ? syncedThreadMessageCount
            : syncedThreadMessages.length
        }
      }));
    } catch {
      // Best-effort; keep previous detail/cache and retry later.
      setSyncedConversations((current) => ({
        ...current,
        [conversationId]: {
          ...(current[conversationId] || {}),
          inFlight: false,
          nextRetryAt: Date.now() + conversationThreadSyncRetryMs
        }
      }));
    } finally {
      conversationSyncInFlightRef.current.delete(conversationId);
    }
  }

  async function prefetchConversationDetail(conversationId) {
    if (!conversationId) {
      return;
    }

    if (conversationPrefetchInFlightRef.current.has(conversationId)) {
      return;
    }

    const cached = conversationCacheRef.current.get(conversationId);
    if (cached?.detail && isFresh(cached.fetchedAt, conversationPrefetchTtlMs)) {
      return;
    }

    conversationPrefetchInFlightRef.current.add(conversationId);
    try {
      const result = await request(`/api/inbox/${conversationId}`);
      const fetchedAt = Date.now();
      conversationCacheRef.current.set(conversationId, { detail: result, fetchedAt });

      setConversationDetail((current) => {
        if (!current || current?.conversation?.id !== conversationId) {
          return current;
        }
        return result;
      });

    } catch {
      // Best-effort prefetch.
    } finally {
      conversationPrefetchInFlightRef.current.delete(conversationId);
    }
  }

  function prefetchInboxConversations(items, preserveSelection) {
    const normalizedCount = Number.isFinite(conversationPrefetchCount) ? Math.max(0, Math.trunc(conversationPrefetchCount)) : 0;
    if (normalizedCount <= 0 || !Array.isArray(items) || items.length === 0) {
      return;
    }

    const effectiveSelectedId = preserveSelection && selectedConversationId && items.some((item) => item.id === selectedConversationId)
      ? selectedConversationId
      : items[0]?.id || null;

    const candidateIds = items
      .map((item) => item?.id)
      .filter((id) => id && id !== effectiveSelectedId)
      .slice(0, normalizedCount);

    for (const conversationId of candidateIds) {
      void prefetchConversationDetail(conversationId);
    }
  }

  async function refreshListingsSnapshot(options = {}) {
    const { force = false, background = false } = options;
    const cached = listingsCacheRef.current;
    const canUseCache = !force && Array.isArray(cached.items) && cached.items.length > 0 && isFresh(cached.fetchedAt, listingsCacheTtlMs);
    if (canUseCache) {
      setListings(cached.items);
      setListingsLastFetchedAt(new Date(cached.fetchedAt).toISOString());
      return cached.items;
    }

    if (!background) {
      setListingsLoading(true);
    }
    try {
      const listingsResponse = await request("/api/listings");
      const items = listingsResponse.items || [];
      const fetchedAt = Date.now();
      listingsCacheRef.current = { items, fetchedAt };
      setListings(items);
      setListingsLastFetchedAt(new Date(fetchedAt).toISOString());
      return items;
    } catch (error) {
      if (Array.isArray(cached.items) && cached.items.length > 0) {
        return cached.items;
      }
      throw error;
    } finally {
      if (!background) {
        setListingsLoading(false);
      }
    }
  }

  async function refreshConversationDetail(conversationId, options = {}) {
    const { force = false, background = false } = options;

    if (!conversationId) {
      setConversationDetail(null);
      setConversationLoading(false);
      setConversationRefreshing(false);
      return;
    }

    const requestId = conversationRequestSeq.current + 1;
    conversationRequestSeq.current = requestId;

    const cached = conversationCacheRef.current.get(conversationId);
    if (cached?.detail) {
      setConversationDetail(cached.detail);
    } else {
      setConversationDetail(null);
    }

    if (!force && cached?.detail && isFresh(cached.fetchedAt, conversationCacheTtlMs)) {
      setConversationLoading(false);
      setConversationRefreshing(false);
      if (!background && shouldAutoSyncConversationThread(conversationId, cached.detail)) {
        void runConversationThreadSync(conversationId, requestId);
      }
      return;
    }

    if (!background && !cached?.detail) {
      setConversationLoading(true);
    } else {
      setConversationRefreshing(true);
    }

    try {
      const result = await request(`/api/inbox/${conversationId}`);
      if (requestId !== conversationRequestSeq.current) {
        return;
      }

      const fetchedAt = Date.now();
      setConversationDetail(result);
      conversationCacheRef.current.set(conversationId, { detail: result, fetchedAt });
      if (!background && shouldAutoSyncConversationThread(conversationId, result)) {
        void runConversationThreadSync(conversationId, requestId);
      }
    } catch (error) {
      if (requestId === conversationRequestSeq.current) {
        setApiError(error.message);
      }
    } finally {
      if (requestId === conversationRequestSeq.current) {
        setConversationLoading(false);
        setConversationRefreshing(false);
      }
    }
  }

  async function refreshInbox(
    status = selectedInboxStatus,
    preserveSelection = true,
    platform = selectedInboxPlatform,
    options = {}
  ) {
    if (!user) {
      return;
    }

    const { force = false, background = false } = options;
    const statusValue = status || "all";
    const platformValue = platform || "all";
    const cacheKey = `${statusValue}::${platformValue}`;
    const cached = inboxCacheRef.current.get(cacheKey);
    if (!force && cached?.items && isFresh(cached.fetchedAt, inboxCacheTtlMs)) {
      applyInboxItems(cached.items, preserveSelection);
      setInboxLastFetchedAt(new Date(cached.fetchedAt).toISOString());
      if (!background) {
        prefetchInboxConversations(cached.items, preserveSelection);
      }
      return;
    }

    const requestId = inboxRequestSeq.current + 1;
    inboxRequestSeq.current = requestId;
    if (!background) {
      setInboxLoading(true);
    }

    try {
      const params = new URLSearchParams();
      if (statusValue !== "all") {
        params.set("status", statusValue);
      }
      if (platformValue !== "all") {
        params.set("platform", platformValue);
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      const result = await request(`/api/inbox${query}`);
      if (requestId !== inboxRequestSeq.current) {
        return;
      }

      const items = result.items || [];
      const fetchedAt = Date.now();
      inboxCacheRef.current.set(cacheKey, { items, fetchedAt });
      setInboxLastFetchedAt(new Date(fetchedAt).toISOString());
      applyInboxItems(items, preserveSelection);
      if (!background) {
        prefetchInboxConversations(items, preserveSelection);
      }
    } catch (error) {
      if (requestId === inboxRequestSeq.current) {
        setApiError(error.message);
      }
    } finally {
      if (!background && requestId === inboxRequestSeq.current) {
        setInboxLoading(false);
      }
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

  async function refreshData(options = {}) {
    if (!user) {
      return;
    }

    const { forceListings = false } = options;
    setApiError("");
    try {
      const [agentsResponse, unitsResponse, listingItems] = await Promise.all([
        request("/api/agents"),
        request("/api/units"),
        refreshListingsSnapshot({ force: forceListings })
      ]);

      setAgents(agentsResponse.items || []);
      setUnits(unitsResponse.items || []);
      setListings(listingItems);

      const fallbackUnitId = selectedUnitId || unitsResponse.items?.[0]?.id || "";
      const fallbackListingId = listingItems?.[0]?.id || "";
      setSelectedUnitId((current) => current || fallbackUnitId);
      setAssignmentForm((current) => ({
        ...current,
        listingId: current.listingId || fallbackListingId,
        unitId:
          current.unitId
          || listingItems?.find((item) => item.id === current.listingId)?.unitId
          || listingItems?.find((item) => item.id === fallbackListingId)?.unitId
          || fallbackUnitId
      }));

      await Promise.all([
        refreshInbox(selectedInboxStatus, false, selectedInboxPlatform, { force: true }),
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
      inboxCacheRef.current.clear();
      conversationCacheRef.current.clear();
      conversationPrefetchInFlightRef.current.clear();
      conversationSyncInFlightRef.current.clear();
      listingsCacheRef.current = { items: [], fetchedAt: 0 };
      setInboxItems([]);
      setSelectedConversationId("");
      setConversationDetail(null);
      setConversationLoading(false);
      setConversationRefreshing(false);
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
      await Promise.all([
        refreshInbox(selectedInboxStatus, true, selectedInboxPlatform, { force: true }),
        refreshConversationDetail(selectedConversationId, { force: true })
      ]);
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
        refreshInbox(selectedInboxStatus, true, selectedInboxPlatform, { force: true }),
        refreshConversationDetail(conversationId, { force: true }),
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
      await Promise.all([
        refreshInbox(selectedInboxStatus, true, selectedInboxPlatform, { force: true }),
        refreshConversationDetail(selectedConversationId, { force: true })
      ]);
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
      await Promise.all([
        refreshInbox(selectedInboxStatus, true, selectedInboxPlatform, { force: true }),
        refreshConversationDetail(selectedConversationId, { force: true })
      ]);
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
      inboxCacheRef.current.clear();
      conversationCacheRef.current.clear();
      conversationPrefetchInFlightRef.current.clear();
      conversationSyncInFlightRef.current.clear();
      listingsCacheRef.current = { items: [], fetchedAt: 0 };
      setInboxItems([]);
      setSelectedConversationId("");
      setConversationDetail(null);
      setConversationLoading(false);
      setConversationRefreshing(false);
      return;
    }
    refreshData({ forceListings: true });
  }, [user]);

  useEffect(() => {
    if (!user) {
      return;
    }
    refreshInbox(selectedInboxStatus, true, selectedInboxPlatform, { force: true });
  }, [user, selectedInboxStatus, selectedInboxPlatform]);

  useEffect(() => {
    refreshConversationDetail(selectedConversationId);
  }, [selectedConversationId]);

  useEffect(() => {
    if (!user) {
      return;
    }
    if (!Number.isFinite(inboxPollIntervalMs) || inboxPollIntervalMs <= 0) {
      return;
    }

    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        await refreshInbox(selectedInboxStatus, true, selectedInboxPlatform, {
          force: true,
          background: true
        });
        if (selectedConversationId) {
          await refreshConversationDetail(selectedConversationId, {
            force: true,
            background: true
          });
        }
      } finally {
        inFlight = false;
      }
    }, inboxPollIntervalMs);

    return () => clearInterval(timer);
  }, [user, selectedInboxStatus, selectedInboxPlatform, selectedConversationId]);

  useEffect(() => {
    if (!user) {
      return;
    }
    if (!Number.isFinite(listingsPollIntervalMs) || listingsPollIntervalMs <= 0) {
      return;
    }

    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        await refreshListingsSnapshot({
          force: true,
          background: true
        });
      } finally {
        inFlight = false;
      }
    }, listingsPollIntervalMs);

    return () => clearInterval(timer);
  }, [user]);

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
    listingsLoading,
    listingsLastFetchedAt,
    selectedUnitId,
    setSelectedUnitId,
    availability,
    weeklyRules,
    assignmentForm,
    setAssignmentForm,
    selectedUnitListings,
    inboxItems,
    inboxLoading,
    inboxLastFetchedAt,
    selectedInboxStatus,
    setSelectedInboxStatus,
    selectedInboxPlatform,
    setSelectedInboxPlatform,
    selectedConversationId,
    setSelectedConversationId,
    conversationDetail,
    conversationLoading,
    conversationRefreshing,
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
    refreshListings: refreshListingsSnapshot,
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
