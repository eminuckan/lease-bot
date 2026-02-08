import { Save, Building2, List, Users } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { useLeaseBot } from "../state/lease-bot-context";

function parseDateValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortListingsForAssignment(a, b) {
  const aActiveRank = a.status === "active" ? 0 : 1;
  const bActiveRank = b.status === "active" ? 0 : 1;
  if (aActiveRank !== bActiveRank) {
    return aActiveRank - bActiveRank;
  }
  return parseDateValue(b.updatedAt) - parseDateValue(a.updatedAt);
}

function formatListingLabel(item, unitLabel) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  const location = typeof metadata.location === "string" ? metadata.location.trim() : "";
  const priceText = typeof metadata.priceText === "string" ? metadata.priceText.trim() : "";
  const listingExternalId = typeof item?.listingExternalId === "string" ? item.listingExternalId.trim() : "";

  const primary = title
    || (listingExternalId ? `Listing #${listingExternalId}` : `Listing ${String(item.id || "").slice(0, 8)}`);

  const details = [];
  if (unitLabel) {
    details.push(unitLabel);
  }
  if (location) {
    details.push(location);
  }
  if (priceText) {
    details.push(priceText);
  }
  details.push(item.status === "active" ? "active" : "inactive");

  return `${primary} (${details.join(" • ")})`;
}

export function AssignmentPanel() {
  const { units, listings, agents, assignmentForm, setAssignmentForm, saveAssignment } =
    useLeaseBot();

  async function handleSubmit(event) {
    await saveAssignment(event);
  }

  const unitLabelById = useMemo(
    () =>
      new Map(
        units.map((item) => [
          item.id,
          [item.propertyName, item.unitNumber].filter(Boolean).join(" ").trim() || "Unknown unit"
        ])
      ),
    [units]
  );

  const sortedListings = useMemo(
    () => [...listings].sort(sortListingsForAssignment),
    [listings]
  );

  useEffect(() => {
    if (sortedListings.length === 0) {
      return;
    }

    const selected = sortedListings.find((item) => item.id === assignmentForm.listingId) || null;
    if (!selected) {
      const first = sortedListings[0];
      setAssignmentForm((current) => ({
        ...current,
        listingId: first.id,
        unitId: first.unitId || ""
      }));
      return;
    }

    if (selected.unitId && selected.unitId !== assignmentForm.unitId) {
      setAssignmentForm((current) => ({
        ...current,
        unitId: selected.unitId
      }));
    }
  }, [sortedListings, assignmentForm.listingId, assignmentForm.unitId, setAssignmentForm]);

  const selectedListing = useMemo(
    () => sortedListings.find((item) => item.id === assignmentForm.listingId) || null,
    [sortedListings, assignmentForm.listingId]
  );

  const selectedUnitLabel = selectedListing?.unitId ? unitLabelById.get(selectedListing.unitId) || "" : "";

  return (
    <div className="p-6">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex items-center gap-4 rounded-lg bg-card px-5 py-5 shadow-card">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted">
              <Building2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{units.length}</p>
              <p className="text-xs text-muted-foreground">Units</p>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-lg bg-card px-5 py-5 shadow-card">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted">
              <List className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{listings.length}</p>
              <p className="text-xs text-muted-foreground">Listings</p>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-lg bg-card px-5 py-5 shadow-card">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{agents.length}</p>
              <p className="text-xs text-muted-foreground">Agents</p>
            </div>
          </div>
        </div>

        {/* Assignment form */}
        <div>
          <h2 className="text-sm font-semibold">Assign listing</h2>
          <p className="mt-1 text-xs text-muted-foreground">Select listing and assign responsible agent.</p>
          <div className="mt-4">
            {listings.length === 0 || agents.length === 0 ? (
              <div className="rounded-lg bg-card px-5 py-8 text-center text-sm text-muted-foreground shadow-card">
                Loading required data...
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className="space-y-3">
                  <div className="rounded-lg bg-card p-4 shadow-card">
                    <Label className="text-xs text-muted-foreground">Listing</Label>
                    <Select
                      value={assignmentForm.listingId || "__none__"}
                      onValueChange={(v) => {
                        const nextListingId = v === "__none__" ? "" : v;
                        const nextListing = sortedListings.find((item) => item.id === nextListingId) || null;
                        setAssignmentForm((current) => ({
                          ...current,
                          listingId: nextListingId,
                          unitId: nextListing?.unitId || ""
                        }));
                      }}
                    >
                      <SelectTrigger className="mt-1.5 h-9 text-sm">
                        <SelectValue placeholder="Select listing" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Select listing</SelectItem>
                        {sortedListings.length === 0 ? (
                          <SelectItem value="__empty__" disabled>No listings available</SelectItem>
                        ) : null}
                        {sortedListings.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {formatListingLabel(item, unitLabelById.get(item.unitId))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedUnitLabel ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Unit: {selectedUnitLabel}
                      </p>
                    ) : null}
                  </div>
                  <div className="rounded-lg bg-card p-4 shadow-card">
                    <Label className="text-xs text-muted-foreground">Agent</Label>
                    <Select
                      value={assignmentForm.agentId || "__none__"}
                      onValueChange={(v) => setAssignmentForm((c) => ({ ...c, agentId: v === "__none__" ? "" : v }))}
                    >
                      <SelectTrigger className="mt-1.5 h-9 text-sm">
                        <SelectValue placeholder="Unassign" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Unassign</SelectItem>
                        {agents.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="mt-4">
                  <Button type="submit" size="sm" disabled={!assignmentForm.listingId}>
                    <Save className="mr-2 h-3.5 w-3.5" />
                    Save assignment
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
