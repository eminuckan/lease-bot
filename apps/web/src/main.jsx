import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { router } from "./router";
import { LeaseBotProvider } from "./state/lease-bot-context";
import { applyTheme, resolvePreferredTheme } from "./lib/theme";
import "./styles.css";

applyTheme(resolvePreferredTheme());

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LeaseBotProvider>
      <RouterProvider router={router} />
      <Toaster richColors closeButton position="top-right" />
    </LeaseBotProvider>
  </StrictMode>
);
