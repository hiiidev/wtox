import React from "react";
import { createRoot } from "react-dom/client";
import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css";
import "./style.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode><App /></React.StrictMode>
);
