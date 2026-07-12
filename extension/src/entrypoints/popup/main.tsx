import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/figtree";
import "@fontsource/dm-mono/500.css";
import { App } from "./App";
import "./style.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
