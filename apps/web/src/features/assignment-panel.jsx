import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { useLeaseBot } from "../state/lease-bot-context";

export function AssignmentPanel() {
  const { units, listings, agents, assignmentForm, setAssignmentForm, saveAssignment } = useLeaseBot();

  return (
    <section>
      <Card>
        <CardHeader>
          <CardTitle>Assignments</CardTitle>
          <CardDescription>Unit to listing to agent mapping with mobile-first controls</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveAssignment} className="space-y-3">
            <Label>
              Unit
              <Select
                value={assignmentForm.unitId}
                onChange={(event) => setAssignmentForm((current) => ({ ...current, unitId: event.target.value }))}
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
                onChange={(event) => setAssignmentForm((current) => ({ ...current, listingId: event.target.value }))}
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
                onChange={(event) => setAssignmentForm((current) => ({ ...current, agentId: event.target.value }))}
              >
                <option value="">Unassign</option>
                {agents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fullName}
                  </option>
                ))}
              </Select>
            </Label>

            <div className="sticky bottom-[4.75rem] z-10 rounded-md bg-card pt-1 sm:bottom-2">
              <Button type="submit" className="w-full">
                Save assignment
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
