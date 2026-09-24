import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./onboarding/App.js";
import "./onboarding/types.js";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
