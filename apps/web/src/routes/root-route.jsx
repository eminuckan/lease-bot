import { Outlet, createRootRoute } from "@tanstack/react-router";

function RootLayout() {
  return <Outlet />;
}

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <main className="p-4 text-sm">Page not found.</main>
});
