import React from "react";
import ReactDOM from "react-dom/client";

// Fonts are bundled offline via @fontsource; nothing loads from a CDN.
import "@fontsource-variable/instrument-sans";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./App.css";

import App from "./App";
import { initTheme } from "./lib/theme";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
