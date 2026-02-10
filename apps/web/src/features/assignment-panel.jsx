import {
  Save,
  Building2,
  List,
  Users,
  Search,
  Pencil,
  UserMinus,
  Rows3,
  Users2,
  ArrowUpDown
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
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

function formatListingLabel(item) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  const location = typeof metadata.location === "string" ? metadata.location.trim() : "";
  const priceText = typeof metadata.priceText === "string" ? metadata.priceText.trim() : "";
  const listingExternalId = typeof item?.listingExternalId === "string" ? item.listingExternalId.trim() : "";
  const platform = typeof item?.platform === "string" ? item.platform.trim().toUpperCase() : "";

  const primary = title
    || (listingExternalId ? `Listing #${listingExternalId}` : `Listing ${String(item.id || "").slice(0, 8)}`);
  const primaryWithPlatform = platform ? `${platform} · ${primary}` : primary;

  const details = [];
  if (location) {
    details.push(location);
  }
  if (priceText) {
    details.push(priceText);
  }
  details.push(item.status === "active" ? "active" : "inactive");

  return `${primaryWithPlatform} (${details.join(" • ")})`;
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

function SortableHead({ column, label, className = "" }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground ${className}`}
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label}
      <ArrowUpDown className="h-3.5 w-3.5" />
    </button>
  );
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
  const [bulkAgentId, setBulkAgentId] = useState("__none__");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sorting, setSorting] = useState([
    { id: "status", desc: false },
    { id: "updatedAt", desc: true }
  ]);
  const [columnFilters, setColumnFilters] = useState([]);
  const [rowSelection, setRowSelection] = useState({});

  async function handleSubmit(event) {
    await saveAssignment(event);
  }

  const agentById = useMemo(
    () => new Map(agents.map((item) => [item.id, item.fullName])),
    [agents]
  );

  const assignmentTargets = useMemo(
    () => buildAssignmentTargets(units, listings),
    [units, listings]
  );

  const targetByListingId = useMemo(
    () => new Map(assignmentTargets.map((item) => [item.listing.id, item])),
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

  const tableRows = useMemo(
    () => assignmentTargets.map((target) => {
      const assignedAgentId = target.unit.assignedAgentId || "";
      const assignedAgentName = assignedAgentId ? (agentById.get(assignedAgentId) || "Unknown agent") : "Unassigned";
      const status = target.listing.status === "active" ? "active" : "inactive";
      return {
        id: target.listing.id,
        unitId: target.unit.id,
        listing: formatListingLabel(target.listing),
        sourceCount: target.sourceCount,
        status,
        assignedState: assignedAgentId ? "assigned" : "unassigned",
        agentName: assignedAgentName,
        updatedAt: target.listing.updatedAt,
        target
      };
    }),
    [assignmentTargets, agentById]
  );

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
      successLabel: "Listing unassigned"
    });
  }

  const columns = useMemo(
    () => [
      {
        id: "select",
        enableSorting: false,
        enableColumnFilter: false,
        header: ({ table }) => (
          <input
            type="checkbox"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
            aria-label="Select all rows"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            aria-label={`Select ${row.original.listing}`}
          />
        )
      },
      {
        accessorKey: "listing",
        header: ({ column }) => <SortableHead column={column} label="Listing" />,
        cell: ({ row }) => <div className="max-w-[520px] truncate text-sm font-medium">{row.original.listing}</div>
      },
      {
        accessorKey: "sourceCount",
        header: ({ column }) => <SortableHead column={column} label="Sources" />,
        cell: ({ row }) => <Badge>{row.original.sourceCount}</Badge>
      },
      {
        accessorKey: "status",
        filterFn: "equalsString",
        sortingFn: (a, b) => {
          const rank = (value) => (value === "active" ? 0 : 1);
          return rank(a.original.status) - rank(b.original.status);
        },
        header: ({ column }) => <SortableHead column={column} label="Status" />,
        cell: ({ row }) => (
          <Badge
            className={
              row.original.status === "active"
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-muted text-muted-foreground"
            }
          >
            {row.original.status}
          </Badge>
        )
      },
      {
        accessorKey: "assignedState",
        filterFn: "equalsString",
        header: ({ column }) => <SortableHead column={column} label="Assignment" />,
        cell: ({ row }) => (
          <Badge
            className={
              row.original.assignedState === "assigned"
                ? "bg-sky-500/15 text-sky-300"
                : "bg-muted text-muted-foreground"
            }
          >
            {row.original.assignedState}
          </Badge>
        )
      },
      {
        accessorKey: "agentName",
        header: ({ column }) => <SortableHead column={column} label="Agent" />,
        cell: ({ row }) => <span className="text-sm">{row.original.agentName}</span>
      },
      {
        accessorKey: "updatedAt",
        sortingFn: (a, b) => parseDateValue(a.original.updatedAt) - parseDateValue(b.original.updatedAt),
        header: ({ column }) => <SortableHead column={column} label="Updated" />,
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatTimestamp(row.original.updatedAt)}</span>
      },
      {
        id: "actions",
        enableSorting: false,
        enableColumnFilter: false,
        header: () => <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</span>,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => editAssignment(row.original.target)}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => unassignRow(row.original.target)}
            >
              <UserMinus className="mr-1.5 h-3.5 w-3.5" />
              Unassign
            </Button>
          </div>
        )
      }
    ],
    []
  );

  const table = useReactTable({
    data: tableRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.unitId,
    state: {
      sorting,
      columnFilters,
      rowSelection
    }
  });

  const searchFilter = (table.getColumn("listing")?.getFilterValue() ?? "")?.toString();
  const statusFilter = (table.getColumn("status")?.getFilterValue() ?? "__all__")?.toString();
  const assignedFilter = (table.getColumn("assignedState")?.getFilterValue() ?? "__all__")?.toString();

  const selectedUnitIds = table.getSelectedRowModel().rows.map((row) => row.original.unitId);
  const selectedCount = selectedUnitIds.length;
  const visibleRows = table.getRowModel().rows;

  async function runBulkAssign(agentId) {
    if (selectedUnitIds.length === 0 || bulkBusy) {
      return;
    }
    setBulkBusy(true);
    try {
      await bulkUpdateUnitAssignments(selectedUnitIds, agentId || null, {
        successLabel: agentId ? "Bulk assign completed" : "Bulk unassign completed"
      });
      setRowSelection({});
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="w-full space-y-8">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex items-center gap-4 rounded-lg bg-card px-5 py-5 shadow-card">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted">
              <Building2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{assignmentTargets.length}</p>
              <p className="text-xs text-muted-foreground">Rows</p>
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
                      <SelectTrigger className="mt-1.5">
                        <SelectValue placeholder="Select listing" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Select listing</SelectItem>
                        {assignmentTargets.length === 0 ? (
                          <SelectItem value="__empty__" disabled>No listings available</SelectItem>
                        ) : null}
                        {assignmentTargets.map((item) => (
                          <SelectItem key={item.listing.id} value={item.listing.id}>
                            {formatListingLabel(item.listing)}
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
                      <SelectTrigger className="mt-1.5">
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

        <div className="space-y-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h3 className="text-sm font-semibold">Assignment table</h3>
              <p className="text-xs text-muted-foreground">
                Manage listing assignments, sort columns, and apply bulk actions.
              </p>
              <p className="text-[11px] text-muted-foreground/80">
                Default sorting: active listings first.
              </p>
            </div>
            <div className="grid w-full gap-2 sm:grid-cols-2 xl:grid-cols-3">
              <div className="relative sm:col-span-2 xl:col-span-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchFilter}
                  onChange={(event) => table.getColumn("listing")?.setFilterValue(event.target.value)}
                  placeholder="Search listing"
                  className="pl-10"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(value) => table.getColumn("status")?.setFilterValue(value === "__all__" ? undefined : value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={assignedFilter}
                onValueChange={(value) => table.getColumn("assignedState")?.setFilterValue(value === "__all__" ? undefined : value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All assignments" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All assignments</SelectItem>
                  <SelectItem value="assigned">Assigned</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/30 p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Rows3 className="h-4 w-4" />
              <span>{selectedCount} selected</span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select value={bulkAgentId} onValueChange={setBulkAgentId}>
                <SelectTrigger className="w-full sm:w-56">
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
                onClick={() => setRowSelection({})}
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="space-y-2 md:hidden">
            {visibleRows.length === 0 ? (
              <div className="rounded-md border border-border px-4 py-8 text-center text-sm text-muted-foreground">
                No rows found.
              </div>
            ) : null}
            {visibleRows.map((row) => (
              <div key={`${row.id}-mobile`} className="rounded-md border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <label className="flex min-w-0 flex-1 items-start gap-2">
                    <input
                      type="checkbox"
                      checked={row.getIsSelected()}
                      onChange={row.getToggleSelectedHandler()}
                      aria-label={`Select ${row.original.listing}`}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="line-clamp-2 text-sm font-medium">{row.original.listing}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Updated: {formatTimestamp(row.original.updatedAt)}
                      </span>
                    </span>
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge>{row.original.sourceCount}</Badge>
                  <Badge className={row.original.status === "active" ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground"}>
                    {row.original.status}
                  </Badge>
                  <Badge className={row.original.assignedState === "assigned" ? "bg-sky-500/15 text-sky-300" : "bg-muted text-muted-foreground"}>
                    {row.original.assignedState}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Agent: {row.original.agentName}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => editAssignment(row.original.target)}
                  >
                    <Pencil className="mr-1.5 h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => unassignRow(row.original.target)}
                  >
                    <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                    Unassign
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden overflow-x-auto border border-border md:block">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      No rows found.
                    </TableCell>
                  </TableRow>
                ) : null}
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  );
}
