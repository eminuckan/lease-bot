import { Save, Building2, List, Users } from "lucide-react";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { useLeaseBot } from "../state/lease-bot-context";

export function AssignmentPanel() {
  const { units, listings, agents, assignmentForm, setAssignmentForm, saveAssignment } =
    useLeaseBot();

  async function handleSubmit(event) {
    await saveAssignment(event);
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex items-center gap-4 rounded-2xl bg-card px-5 py-5 shadow-card">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
              <Building2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{units.length}</p>
              <p className="text-xs text-muted-foreground">Units</p>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-2xl bg-card px-5 py-5 shadow-card">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
              <List className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{listings.length}</p>
              <p className="text-xs text-muted-foreground">Listings</p>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-2xl bg-card px-5 py-5 shadow-card">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
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
          <div className="mt-4 rounded-2xl bg-card shadow-card">
            {units.length === 0 || agents.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                Loading required data...
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className="space-y-1 p-5">
                  <div className="rounded-xl bg-muted p-4">
                    <Label className="text-xs text-muted-foreground">Unit</Label>
                    <Select
                      value={assignmentForm.unitId}
                      onChange={(e) => setAssignmentForm((c) => ({ ...c, unitId: e.target.value }))}
                      required
                      className="mt-1.5 h-9 bg-card text-sm"
                    >
                      <option value="">Select unit</option>
                      {units.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.propertyName} {item.unitNumber}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="rounded-xl bg-muted p-4">
                    <Label className="text-xs text-muted-foreground">Listing</Label>
                    <Select
                      value={assignmentForm.listingId}
                      onChange={(e) => setAssignmentForm((c) => ({ ...c, listingId: e.target.value }))}
                      className="mt-1.5 h-9 bg-card text-sm"
                    >
                      <option value="">Latest for unit</option>
                      {listings
                        .filter((item) => item.unitId === assignmentForm.unitId)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.id.slice(0, 8)} ({item.status})
                          </option>
                        ))}
                    </Select>
                  </div>
                  <div className="rounded-xl bg-muted p-4">
                    <Label className="text-xs text-muted-foreground">Agent</Label>
                    <Select
                      value={assignmentForm.agentId}
                      onChange={(e) => setAssignmentForm((c) => ({ ...c, agentId: e.target.value }))}
                      className="mt-1.5 h-9 bg-card text-sm"
                    >
                      <option value="">Unassign</option>
                      {agents.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.fullName}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="px-5 pb-5">
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
