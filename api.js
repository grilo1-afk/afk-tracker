import { supabase } from "./supabase-client.js";
import { dbRowsToState, getDisplayName, cacheDisplayName } from "./state.js";

// Callers should catch errors and call handleSessionInvalid if needed.
// api.js does not import auth.js to avoid circular dependencies.

function classifyError(error) {
  // Network-level failures (fetch couldn't reach the server) have no .code
  if (!error || (!error.code && !error.message)) {
    return { kind: "network", message: "You're offline — check your connection and try again." };
  }

  const msg = (error.message || "").toLowerCase();
  const code = error.code || "";

  if (code === "PGRST301" || msg.includes("jwt")) {
    return { kind: "auth", message: "Your session has expired. Please log in again." };
  }
  if (code === "42501" || msg.includes("row-level security")) {
    return { kind: "permission", message: "You don't have permission to do that." };
  }
  if (["23505", "23502", "23503", "23514"].includes(code)) {
    // unique violation, not-null violation, foreign key violation, check constraint
    return { kind: "validation", message: "That value isn't valid. Check your entry and try again." };
  }
  if (
    error.name === "TypeError" ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  ) {
    return { kind: "network", message: "You're offline — check your connection and try again." };
  }

  return { kind: "unknown", message: "Something went wrong. Try again." };
}

export async function loadState() {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;

  const [monthsResult, profileResult] = await Promise.all([
    supabase
      .from("months")
      .select("*, expenses(*)")
      .is("deleted_at", null)
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .order("expense_date", { foreignTable: "expenses", ascending: false })
      .order("created_at", { foreignTable: "expenses", ascending: false }),
    user
      ? supabase
          .from("profiles")
          .select("display_name")
          .eq("id", user.id)
          .single()
      : Promise.resolve({ data: null }),
  ]);

  if (monthsResult.error) {
    const classified = classifyError(monthsResult.error);
    throw Object.assign(new Error(classified.message), { kind: classified.kind });
  }

  const newState = dbRowsToState(monthsResult.data || []);
  const displayName =
    (profileResult.data && profileResult.data.display_name) || null;
  if (displayName) cacheDisplayName(displayName);
  newState.displayName = displayName || getDisplayName();
  return newState;
}

export async function dbAddMonth(year, monthOneBased, name, onAuthError) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;
  if (!user) {
    onAuthError && onAuthError();
    return null;
  }

  const { data, error } = await supabase
    .from("months")
    .insert({ user_id: user.id, year, month: monthOneBased, name })
    .select("id")
    .single();

  if (error) {
    console.error("dbAddMonth:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: data.id };
}

export async function dbUpdateBudget(monthUuid, budget) {
  const { error } = await supabase
    .from("months")
    .update({ budget })
    .eq("id", monthUuid);

  if (error) {
    console.error("dbUpdateBudget:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: undefined };
}

export async function dbDeleteMonth(monthUuid) {
  const { error } = await supabase
    .from("months")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", monthUuid);

  if (error) {
    console.error("dbDeleteMonth:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: undefined };
}

export async function dbAddExpense(monthUuid, desc, amount, expenseDate) {
  const { data, error } = await supabase
    .from("expenses")
    .insert({
      month_id: monthUuid,
      description: desc,
      amount,
      expense_date: expenseDate,
    })
    .select("id, created_at")
    .single();

  if (error) {
    console.error("dbAddExpense:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: data };
}

export async function dbUpdateExpense(expenseUuid, desc, amount, expenseDate) {
  const { error } = await supabase
    .from("expenses")
    .update({ description: desc, amount, expense_date: expenseDate })
    .eq("id", expenseUuid);

  if (error) {
    console.error("dbUpdateExpense:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: undefined };
}

export async function dbDeleteExpense(expenseUuid) {
  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("id", expenseUuid);

  if (error) {
    console.error("dbDeleteExpense:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: undefined };
}

export async function dbUpdateDisplayName(name) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;
  if (!user) return { ok: false, kind: "auth", message: "Your session has expired. Please log in again." };

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: name })
    .eq("id", user.id);

  if (error) {
    console.error("dbUpdateDisplayName:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: undefined };
}

export async function dbUpdatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    console.error("dbUpdatePassword:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: undefined };
}
