import "react-day-picker/style.css";
import { DayPicker } from "react-day-picker";
import { cn } from "../../lib/utils";

export function Calendar({ className, ...props }) {
  return <DayPicker className={cn("rdp-leasebot p-2", className)} showOutsideDays {...props} />;
}
