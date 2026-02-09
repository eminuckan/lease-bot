import { Save, Building2, List, Users, Search, Pencil, UserMinus, Rows3, Users2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell
} from "../components/ui/table";
import { formatTimestamp } from "../lib/utils";
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

function buildAssignmentTargets(units, listings) {
  const listingsByUnitId = new Map();
  for (const listing of listings) {
    if (!listing?.unitId) {
      continue;
    }
    if (!listingsByUnitId.has(listing.unitId)) {
      listingsByUnitId.set(listing.unitId, []);
    }
    listingsByUnitId.get(listing.unitId).push(listing);
  }

  const sortedUnits = [...units].sort((a, b) => {
    const aLabel = [a.propertyName, a.unitNumber].filter(Boolean).join(" ").trim().toLowerCase();
    const bLabel = [b.propertyName, b.unitNumber].filter(Boolean).join(" ").trim().toLowerCase();
    return aLabel.localeCompare(bLabel);
  });

  return sortedUnits
    .map((unit) => {
      const candidates = [...(listingsByUnitId.get(unit.id) || [])].sort(sortListingsForAssignment);
      if (candidates.length === 0) {
        return null;
      }
      const listing = candidates[0];
      return {
        unit,
        listing,
        sourceCount: candidates.length
      };
    })
    .filter(Boolean);
}

export function AssignmentPanel() {
  const {
    units,
    listings,
    agents,
    assignmentForm,
    setAssignmentForm,
    saveAssignment,
    updateUnitAssignment,
    bulkUpdateUnitAssignments
  } = useLeaseBot();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedUnitIds, setSelectedUnitIds] = useState([]);
  const [bulkAgentId, setBulkAgentId] = useState("__none__");
  const [bulkBusy, setBulkBusy] = useState(false);

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

  const agentById = useMemo(
    () =>
      new Map(
        agents.map((item) => [item.id, item.fullName])
      ),
    [agents]
  );

  const assignmentTargets = useMemo(
    () => buildAssignmentTargets(units, listings),
    [units, listings]
  );

  const targetByListingId = useMemo(
    () =>
      new Map(
        assignmentTargets.map((item) => [item.listing.id, item])
      ),
    [assignmentTargets]
  );

  useEffect(() => {
    if (assignmentTargets.length === 0) {
      return;
    }

    const selected = targetByListingId.get(assignmentForm.listingId) || null;
    if (!selected) {
      const first = assignmentTargets[0];
      setAssignmentForm((current) => ({
        ...current,
        listingId: first.listing.id,
        unitId: first.unit.id
      }));
      return;
    }

    if (selected.unit.id !== assignmentForm.unitId) {
      setAssignmentForm((current) => ({
        ...current,
        unitId: selected.unit.id
      }));
    }
  }, [assignmentTargets, targetByListingId, assignmentForm.listingId, assignmentForm.unitId, setAssignmentForm]);

  const selectedListing = useMemo(
    () => targetByListingId.get(assignmentForm.listingId)?.listing || null,
    [targetByListingId, assignmentForm.listingId]
  );

  const selectedUnitLabel = selectedListing?.unitId
    ? unitLabelById.get(selectedListing.unitId) || ""
    : "";

  const filteredTargets = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    if (!normalizedSearch) {
      return assignmentTargets;
    }

    return assignmentTargets.filter((item) => {
      const unitLabel = unitLabelById.get(item.unit.id) || "";
      const listingLabel = formatListingLabel(item.listing, unitLabel);
      const assignedAgent = item.unit.assignedAgentId ? (agentById.get(item.unit.assignedAgentId) || "") : "";
      const haystack = `${listingLabel} ${unitLabel} ${assignedAgent}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [searchTerm, assignmentTargets, unitLabelById, agentById]);

  const selectedUnitSet = useMemo(
    () => new Set(selectedUnitIds),
    [selectedUnitIds]
  );

  const allVisibleSelected = filteredTargets.length > 0
    && filteredTargets.every((item) => selectedUnitSet.has(item.unit.id));

  const selectedCount = selectedUnitIds.length;

  function toggleVisibleSelection(checked) {
    if (!checked) {
      const visibleUnitIds = new Set(filteredTargets.map((item) => item.unit.id));
      setSelectedUnitIds((current) => current.filter((unitId) => !visibleUnitIds.has(unitId)));
      return;
    }

    setSelectedUnitIds((current) => {
      const merged = new Set(current);
      for (const row of filteredTargets) {
        merged.add(row.unit.id);
      }
      return Array.from(merged);
    });
  }

  function toggleRowSelection(unitId, checked) {
    setSelectedUnitIds((current) => {
      if (checked) {
        return Array.from(new Set([...current, unitId]));
      }
      return current.filter((id) => id !== unitId);
    });
  }

  function editAssignment(target) {
    setAssignmentForm((current) => ({
      ...current,
      listingId: target.listing.id,
      unitId: target.unit.id,
      agentId: target.unit.assignedAgentId || ""
    }));
  }

  async function unassignRow(target) {
    await updateUnitAssignment(target.unit.id, null, {
      successLabel: `Unassigned ${unitLabelById.get(target.unit.id) || "listing"}`
    });
  }

  async function runBulkAssign(agentId) {
    if (selectedUnitIds.length === 0 || bulkBusy) {
      return;
    }
    setBulkBusy(true);
    try {
      await bulkUpdateUnitAssignments(selectedUnitIds, agentId || null, {
        successLabel: agentId ? "Bulk assign completed" : "Bulk unassign completed"
      });
      setSelectedUnitIds([]);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mx-auto w-full max-w-[1500px] space-y-8">
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
                        const nextTarget = targetByListingId.get(nextListingId) || null;
                        setAssignmentForm((current) => ({
                          ...current,
                          listingId: nextListingId,
                          unitId: nextTarget?.unit.id || ""
                        }));
                      }}
                    >
                      <SelectTrigger className="mt-1.5 h-9 text-sm">
                        <SelectValue placeholder="Select listing" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Select listing</SelectItem>
                        {assignmentTargets.length === 0 ? (
                          <SelectItem value="__empty__" disabled>No listings available</SelectItem>
                        ) : null}
                        {assignmentTargets.map((item) => (
                          <SelectItem key={item.listing.id} value={item.listing.id}>
                            {formatListingLabel(item.listing, unitLabelById.get(item.unit.id))}
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

        {/* Assignment table */}
        <div className="space-y-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-sm font-semibold">Assignment table</h3>
              <p className="text-xs text-muted-foreground">
                Manage current listing assignments, edit rows, or run bulk actions.
              </p>
            </div>
            <div className="relative w-full md:w-80">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search listing / unit / agent"
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/30 p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Rows3 className="h-4 w-4" />
              <span>{selectedCount} selected</span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select value={bulkAgentId} onValueChange={setBulkAgentId}>
                <SelectTrigger className="h-9 w-full sm:w-56">
                  <SelectValue placeholder="Bulk assign agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Unassign</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                disabled={selectedCount === 0 || bulkBusy}
                onClick={() => runBulkAssign(bulkAgentId === "__none__" ? null : bulkAgentId)}
              >
                <Users2 className="mr-2 h-3.5 w-3.5" />
                Apply to selected
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={selectedCount === 0 || bulkBusy}
                onClick={() => setSelectedUnitIds([])}
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-dashed border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={(event) => toggleVisibleSelection(event.target.checked)}
                      aria-label="Select all visible rows"
                    />
                  </TableHead>
                  <TableHead>Listing</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Sources</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-44">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTargets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      No rows found.
                    </TableCell>
                  </TableRow>
                ) : null}
                {filteredTargets.map((target) => {
                  const unitId = target.unit.id;
                  const unitLabel = unitLabelById.get(unitId) || "Unknown unit";
                  const assignedAgentName = target.unit.assignedAgentId
                    ? (agentById.get(target.unit.assignedAgentId) || "Unknown agent")
                    : "Unassigned";
                  const isSelected = selectedUnitSet.has(unitId);
                  return (
                    <TableRow key={unitId}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(event) => toggleRowSelection(unitId, event.target.checked)}
                          aria-label={`Select ${unitLabel}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="max-w-[360px] truncate text-sm font-medium">
                          {formatListingLabel(target.listing, "")}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{unitLabel}</TableCell>
                      <TableCell>
                        <Badge>{target.sourceCount}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            target.listing.status === "active"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : "bg-muted text-muted-foreground"
                          }
                        >
                          {target.listing.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{assignedAgentName}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatTimestamp(target.listing.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => editAssignment(target)}
                          >
                            <Pencil className="mr-1.5 h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => unassignRow(target)}
                          >
                            <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                            Unassign
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  );
}
