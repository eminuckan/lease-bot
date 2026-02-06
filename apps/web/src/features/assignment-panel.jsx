import { Save } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { useLeaseBot } from "../state/lease-bot-context";

export function AssignmentPanel() {
  const { apiError, units, listings, agents, assignmentForm, setAssignmentForm, saveAssignment } =
    useLeaseBot();

  async function handleSubmit(event) {
    await saveAssignment(event);
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Assignments</h2>

      {apiError ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"
          role="alert"
        >
          {apiError}
        </p>
      ) : null}

      <div className="grid gap-4 text-sm sm:grid-cols-3">
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-2xl font-semibold">{units.length}</p>
          <p className="text-muted-foreground">Units</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-2xl font-semibold">{listings.length}</p>
          <p className="text-muted-foreground">Listings</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-2xl font-semibold">{agents.length}</p>
          <p className="text-muted-foreground">Agents</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assign unit</CardTitle>
        </CardHeader>
        <CardContent>
          {units.length === 0 || agents.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              Required data is still loading. Try refreshing.
            </p>
          ) : null}
          <form onSubmit={handleSubmit} className="space-y-4">
            <Label>
              Unit
              <Select
                value={assignmentForm.unitId}
                onChange={(event) =>
                  setAssignmentForm((current) => ({ ...current, unitId: event.target.value }))
                }
                required
              >
                <option value="">Select unit</option>
                {units.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.propertyName} {item.unitNumber}
                  </option>
                ))}
              </Select>
            </Label>
            <Label>
              Listing
              <Select
                value={assignmentForm.listingId}
                onChange={(event) =>
                  setAssignmentForm((current) => ({ ...current, listingId: event.target.value }))
                }
              >
                <option value="">Latest listing for unit</option>
                {listings
                  .filter((item) => item.unitId === assignmentForm.unitId)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id.slice(0, 8)} ({item.status})
                    </option>
                  ))}
              </Select>
            </Label>
            <Label>
              Agent
              <Select
                value={assignmentForm.agentId}
                onChange={(event) =>
                  setAssignmentForm((current) => ({ ...current, agentId: event.target.value }))
                }
              >
                <option value="">Unassign</option>
                {agents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fullName}
                  </option>
                ))}
              </Select>
            </Label>

            <Button type="submit" className="w-full">
              <Save className="mr-2 h-3.5 w-3.5" />
              Save assignment
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
