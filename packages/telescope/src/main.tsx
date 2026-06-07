import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FileBrowserApp } from "./FileBrowserApp";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FileBrowserApp />
  </StrictMode>
);
