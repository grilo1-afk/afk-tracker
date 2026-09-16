import { supabase } from "./supabase-client.js";
import {
  dbRowsToState, getDisplayName, cacheDisplayName,
} from "./state.js";

// Callers should catch errors and call handleSessionInvalid if needed.
// api.js does not import auth.js to avoid circular dependencies.

export async function loadState() {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;

  const [monthsResult, profileResult] = await Promise.all([
    supabase
      .from("months")
      .select("*, expenses(*)")
      .order("year", { ascending: false })
      .order("month", { ascending: false }),
    user
      ? supabase.from("profiles").select("display_name").eq("id", user.id).single()
      : Promise.resolve({ data: null }),
  ]);

  if (monthsResult.error) {
    throw Object.assign(
      new Error(monthsResult.error.message || "DB_ERROR"),
      { isJwt: !!(monthsResult.error.message && monthsResult.error.message.toLowerCase().includes("jwt")) },
    );
  }

  const newState = dbRowsToState(monthsResult.data || []);
  const displayName = (profileResult.data && profileResult.data.display_name) || null;
  if (displayName) cacheDisplayName(displayName);
  newState.displayName = displayName || getDisplayName();
  return newState;
}

export async function dbAddMonth(year, monthOneBased, name, onAuthError) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;
  if (!user) { onAuthError && onAuthError(); return null; }

  const { data, error } = await supabase
    .from("months")
    .insert({ user_id: user.id, year, month: monthOneBased, name, budget: 0 })
    .select("id")
    .single();

  if (error) {
    console.error("dbAddMonth:", error);
    return null;
  }
  return data.id;
}

export async function dbUpdateBudget(monthUuid, budget) {
  const { error } = await supabase
    .from("months")
    .update({ budget })
    .eq("id", monthUuid);

  if (error) { console.error("dbUpdateBudget:", error); return false; }
  return true;
}

export async function dbDeleteMonth(monthUuid) {
  const { error } = await supabase
    .from("months")
    .delete()
    .eq("id", monthUuid);

  if (error) { console.error("dbDeleteMonth:", error); return false; }
  return true;
}

export async function dbAddExpense(monthUuid, desc, amount, expenseDate) {
  const { data, error } = await supabase
    .from("expenses")
    .insert({ month_id: monthUuid, description: desc, amount, expense_date: expenseDate })
    .select("id, created_at")
    .single();

  if (error) { console.error("dbAddExpense:", error); return null; }
  return data;
}

export async function dbUpdateExpense(expenseUuid, desc, amount, expenseDate) {
  const { error } = await supabase
    .from("expenses")
    .update({ description: desc, amount, expense_date: expenseDate })
    .eq("id", expenseUuid);

  if (error) { console.error("dbUpdateExpense:", error); return false; }
  return true;
}

export async function dbDeleteExpense(expenseUuid) {
  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("id", expenseUuid);

  if (error) { console.error("dbDeleteExpense:", error); return false; }
  return true;
}

export async function dbUpdateDisplayName(name) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;
  if (!user) return false;

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: name })
    .eq("id", user.id);

  if (error) { console.error("dbUpdateDisplayName:", error); return false; }
  return true;
}

export async function dbUpdatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) { console.error("dbUpdatePassword:", error); return { ok: false, message: error.message }; }
  return { ok: true };
}