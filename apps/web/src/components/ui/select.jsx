import { cn } from "../../lib/utils";

export function Select({ className, ...props }) {
  return (
    <select
      className={cn(
        "flex h-10 w-full appearance-none rounded-xl bg-muted px-3 py-2 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
