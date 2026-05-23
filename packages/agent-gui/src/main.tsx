import React from "react";
import ReactDOM from "react-dom/client";
import Auth from "./windows/Auth";
import Status from "./windows/Status";
import Paths from "./windows/Paths";
import Settings from "./windows/Settings";
import "./App.css";

const params = new URLSearchParams(window.location.search);
const windowName = params.get("window") ?? "status";

const windows: Record<string, React.FC> = {
  auth: Auth,
  status: Status,
  paths: Paths,
  settings: Settings,
};

const Window = windows[windowName] ?? Status;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Window />
  </React.StrictMode>
);
