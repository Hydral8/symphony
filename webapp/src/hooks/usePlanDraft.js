import { useEffect, useState } from "react";
import { LOCAL_STORAGE_KEY } from "../lib/constants";
import { defaultPlan } from "../lib/plan";

function loadLocalDraft() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

export function usePlanDraft() {
  const [plan, setPlan] = useState(() => loadLocalDraft() || defaultPlan());

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(plan));
    } catch (err) {
      // ignore persistence errors
    }
  }, [plan]);

  return { plan, setPlan };
}
