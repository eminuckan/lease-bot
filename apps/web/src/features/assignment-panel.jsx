import { Save, Building2, List, Users } from "lucide-react";
import { useMemo } from "react";
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

function formatListingLabel(item) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  const location = typeof metadata.location === "string" ? metadata.location.trim() : "";
  const priceText = typeof metadata.priceText === "string" ? metadata.priceText.trim() : "";
  const listingExternalId = typeof item?.listingExternalId === "string" ? item.listingExternalId.trim() : "";

  const primary = title
    || (listingExternalId ? `Listing #${listingExternalId}` : `Listing ${String(item.id || "").slice(0, 8)}`);

  const details = [];
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

  const filteredListings = useMemo(
    () => listings
      .filter((item) => item.unitId === assignmentForm.unitId)
      .sort(sortListingsForAssignment),
    [listings, assignmentForm.unitId]
  );

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
          <h2 className="text-sm font-semibold">Assign unit</h2>
          <p className="mt-1 text-xs text-muted-foreground">Link a unit to a listing and agent for automated management.</p>
          <div className="mt-4">
            {units.length === 0 || agents.length === 0 ? (
              <div className="rounded-lg bg-card px-5 py-8 text-center text-sm text-muted-foreground shadow-card">
                Loading required data...
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className="space-y-3">
                  <div className="rounded-lg bg-card p-4 shadow-card">
                    <Label className="text-xs text-muted-foreground">Unit</Label>
                    <Select
                      value={assignmentForm.unitId || "__none__"}
                      onValueChange={(v) => {
                        const nextUnitId = v === "__none__" ? "" : v;
                        const preferredListingId = nextUnitId
                          ? listings
                            .filter((item) => item.unitId === nextUnitId)
                            .sort(sortListingsForAssignment)[0]?.id || ""
                          : "";
                        setAssignmentForm((current) => ({
                          ...current,
                          unitId: nextUnitId,
                          listingId: preferredListingId
                        }));
                      }}
                    >
                      <SelectTrigger className="mt-1.5 h-9 text-sm">
                        <SelectValue placeholder="Select unit" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Select unit</SelectItem>
                        {units.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.propertyName} {item.unitNumber}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="rounded-lg bg-card p-4 shadow-card">
                    <Label className="text-xs text-muted-foreground">Listing</Label>
                    <Select
                      value={assignmentForm.listingId || "__none__"}
                      onValueChange={(v) => setAssignmentForm((c) => ({ ...c, listingId: v === "__none__" ? "" : v }))}
                    >
                      <SelectTrigger className="mt-1.5 h-9 text-sm">
                        <SelectValue placeholder="Latest for unit" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Latest for unit</SelectItem>
                        {filteredListings.length === 0 ? (
                          <SelectItem value="__empty__" disabled>No listings for selected unit</SelectItem>
                        ) : null}
                        {filteredListings.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {formatListingLabel(item)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                  <Button type="submit" size="sm">
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
