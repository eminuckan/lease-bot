import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { LeaseBotProvider } from "./state/lease-bot-context";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LeaseBotProvider>
      <RouterProvider router={router} />
    </LeaseBotProvider>
  </StrictMode>
);
