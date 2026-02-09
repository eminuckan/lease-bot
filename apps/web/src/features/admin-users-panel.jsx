import { useMemo, useState } from "react";
import { MailPlus, Search, UserMinus } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Badge } from "../components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { formatTimestamp } from "../lib/utils";
import { useLeaseBot } from "../state/lease-bot-context";

function byRecent(left, right) {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || "") || 0;
  const rightTime = Date.parse(right.updatedAt || right.createdAt || "") || 0;
  return rightTime - leftTime;
}

function normalizeSearch(value) {
  return (value || "").toLowerCase().trim();
}

export function AdminUsersPanel() {
  const {
    adminUsers,
    userInvitations,
    createUserInvitation,
    revokeUserInvitation,
    apiError
  } = useLeaseBot();

  const [inviteForm, setInviteForm] = useState({
    email: "",
    firstName: "",
    lastName: "",
    role: "agent"
  });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [latestPreviewUrl, setLatestPreviewUrl] = useState("");

  const rows = useMemo(() => {
    const userRows = adminUsers.map((item) => ({
      id: `user:${item.id}`,
      rawId: item.id,
      type: "user",
      name: item.fullName || `${item.firstName || ""} ${item.lastName || ""}`.trim(),
      email: item.email,
      role: item.role,
      status: "active",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      canRevoke: false
    }));

    const invitationRows = userInvitations.map((item) => ({
      id: `invitation:${item.id}`,
      rawId: item.id,
      type: "invitation",
      name: `${item.firstName || ""} ${item.lastName || ""}`.trim(),
      email: item.email,
      role: item.role,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      expiresAt: item.expiresAt,
      canRevoke: item.status === "pending"
    }));

    return [...invitationRows, ...userRows].sort(byRecent);
  }, [adminUsers, userInvitations]);

  const filteredRows = useMemo(() => {
    const searchQuery = normalizeSearch(search);
    return rows.filter((row) => {
      if (typeFilter !== "all" && row.type !== typeFilter) {
        return false;
      }
      if (statusFilter !== "all" && row.status !== statusFilter) {
        return false;
      }
      if (roleFilter !== "all" && row.role !== roleFilter) {
        return false;
      }
      if (!searchQuery) {
        return true;
      }
      const haystack = `${row.name} ${row.email} ${row.role} ${row.status}`.toLowerCase();
      return haystack.includes(searchQuery);
    });
  }, [rows, search, statusFilter, roleFilter, typeFilter]);

  async function submitInvitation(event) {
    event.preventDefault();
    if (inviteBusy) {
      return;
    }

    setInviteBusy(true);
    setLatestPreviewUrl("");
    try {
      const created = await createUserInvitation(inviteForm);
      if (created) {
        setInviteForm({ email: "", firstName: "", lastName: "", role: "agent" });
        if (created.previewUrl) {
          setLatestPreviewUrl(created.previewUrl);
        }
      }
    } finally {
      setInviteBusy(false);
    }
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Invite user</h2>
          <p className="text-xs text-muted-foreground">
            Public registration is disabled. Admins add users by sending secure invite links.
          </p>

          <form onSubmit={submitInvitation} className="grid gap-3 rounded-md border border-dashed border-border p-4 sm:grid-cols-2 lg:grid-cols-5">
            <Label className="grid gap-1 text-xs text-muted-foreground lg:col-span-2">
              Email
              <Input
                type="email"
                value={inviteForm.email}
                onChange={(event) => setInviteForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="agent@example.com"
                required
              />
            </Label>

            <Label className="grid gap-1 text-xs text-muted-foreground">
              First name
              <Input
                value={inviteForm.firstName}
                onChange={(event) => setInviteForm((current) => ({ ...current, firstName: event.target.value }))}
                required
              />
            </Label>

            <Label className="grid gap-1 text-xs text-muted-foreground">
              Last name
              <Input
                value={inviteForm.lastName}
                onChange={(event) => setInviteForm((current) => ({ ...current, lastName: event.target.value }))}
                required
              />
            </Label>

            <Label className="grid gap-1 text-xs text-muted-foreground">
              Role
              <Select
                value={inviteForm.role}
                onValueChange={(value) => setInviteForm((current) => ({ ...current, role: value }))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </Label>

            <div className="sm:col-span-2 lg:col-span-5">
              <Button type="submit" size="sm" disabled={inviteBusy}>
                <MailPlus className="mr-2 h-3.5 w-3.5" />
                {inviteBusy ? "Sending..." : "Send invite"}
              </Button>
            </div>
          </form>

          {latestPreviewUrl ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              SMTP is not configured in this environment. Invite link preview: {latestPreviewUrl}
            </div>
          ) : null}

          {apiError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive-text">
              {apiError}
            </div>
          ) : null}
        </section>

        <section className="space-y-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <h3 className="text-sm font-semibold">Users and invitations</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:items-center">
              <div className="relative min-w-[230px]">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name/email"
                  className="pl-9"
                />
              </div>

              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-9 min-w-[150px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="user">Users</SelectItem>
                  <SelectItem value="invitation">Invitations</SelectItem>
                </SelectContent>
              </Select>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 min-w-[150px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active users</SelectItem>
                  <SelectItem value="pending">Pending invites</SelectItem>
                  <SelectItem value="accepted">Accepted invites</SelectItem>
                  <SelectItem value="expired">Expired invites</SelectItem>
                  <SelectItem value="revoked">Revoked invites</SelectItem>
                </SelectContent>
              </Select>

              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="h-9 min-w-[130px]">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                      No rows found.
                    </TableCell>
                  </TableRow>
                ) : null}

                {filteredRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs text-muted-foreground">{row.type}</TableCell>
                    <TableCell className="text-sm font-medium">{row.name || "n/a"}</TableCell>
                    <TableCell className="text-sm">{row.email}</TableCell>
                    <TableCell>
                      <Badge>{row.role}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={
                          row.status === "pending"
                            ? "bg-amber-500/15 text-amber-200"
                            : row.status === "active"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTimestamp(row.updatedAt || row.createdAt)}</TableCell>
                    <TableCell>
                      {row.canRevoke ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => revokeUserInvitation(row.rawId)}
                        >
                          <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                          Revoke
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </div>
  );
}
