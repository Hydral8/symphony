import React, { useEffect } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import CanvasPlannerView from "./views/CanvasPlannerView";
import ParallelWorldsDashboardView from "./views/ParallelWorldsDashboardView";

export default function App() {
  const location = useLocation();
  const isCanvas = location.pathname === "/" || location.pathname === "/canvas";

  useEffect(() => {
    document.body.classList.toggle("canvas-active", isCanvas);
    return () => document.body.classList.remove("canvas-active");
  }, [isCanvas]);

  return (
    <div className="app-root">
      <div className="view-switch">
        <NavLink
          end
          to="/"
          className={({ isActive }) => `btn small ${isActive ? "active" : "ghost"}`}
        >
          Canvas
        </NavLink>
        <NavLink
          to="/dashboard"
          className={({ isActive }) => `btn small ${isActive ? "active" : "ghost"}`}
        >
          Dashboard
        </NavLink>
      </div>
      <Routes>
        <Route path="/" element={<CanvasPlannerView />} />
        <Route path="/canvas" element={<Navigate to="/" replace />} />
        <Route path="/dashboard" element={<ParallelWorldsDashboardView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
