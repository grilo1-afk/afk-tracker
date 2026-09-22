import { supabase } from "./supabase-client.js";
import { dbRowsToState, getDisplayName, cacheDisplayName } from "./state.js";

// Callers should catch errors and call handleSessionInvalid if needed.
// api.js does not import auth.js to avoid circular dependencies.

function classifyError(error) {
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
    return { kind: "validation", message: "That value isn't valid. Check your entry and try again." };
  }
  if (error.name === "TypeError" || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return { kind: "network", message: "You're offline — check your connection and try again." };
  }
  return { kind: "unknown", message: "Something went wrong. Try again." };
}

export async function loadState() {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;

  const [monthsResult, profileResult, catResult] = await Promise.all([
    supabase
      .from("months")
      .select("*, expenses(*)")
      .is("deleted_at", null)
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .order("expense_date", { foreignTable: "expenses", ascending: false })
      .order("created_at", { foreignTable: "expenses", ascending: false }),
    user
      ? supabase.from("profiles").select("display_name, currency, lifetime_offset").eq("id", user.id).single()
      : Promise.resolve({ data: null }),
    supabase.from("categories").select("id, name").order("created_at", { ascending: true }),
  ]);

  if (monthsResult.error) {
    const classified = classifyError(monthsResult.error);
    throw Object.assign(new Error(classified.message), { kind: classified.kind });
  }
  if (catResult.error) {
    const classified = classifyError(catResult.error);
    throw Object.assign(new Error(classified.message), { kind: classified.kind });
  }

  const newState = dbRowsToState(monthsResult.data || []);
  const displayName = (profileResult.data && profileResult.data.display_name) || null;
  if (displayName) cacheDisplayName(displayName);
  newState.displayName = displayName || getDisplayName();
  newState.categories = (catResult.data || []).map((c) => ({ id: c.id, name: c.name }));
  newState.currency = (profileResult.data && profileResult.data.currency) || "USD";
  newState.lifetimeOffset = Math.round(
    parseFloat((profileResult.data && profileResult.data.lifetime_offset) || 0) * 100
  );
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
  const { error } = await supabase.from("months").update({ budget }).eq("id", monthUuid);
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

export async function dbAddExpense(monthUuid, desc, amount, expenseDate, categoryId = null) {
  const { data, error } = await supabase
    .from("expenses")
    .insert({
      month_id: monthUuid,
      description: desc,
      amount,
      expense_date: expenseDate,
      category_id: categoryId,
    })
    .select("id, created_at")
    .single();
  if (error) {
    console.error("dbAddExpense:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data };
}

export async function dbAddCategory(name) {
  const { data, error } = await supabase
    .from("categories")
    .insert({ name: name.trim() })
    .select("id, name")
    .single();
  if (error) {
    console.error("dbAddCategory:", error);
    return { ok: false, message: "Could not save category." };
  }
  return { ok: true, data: { id: data.id, name: data.name } };
}

export async function dbDeleteCategory(id) {
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) {
    console.error("dbDeleteCategory:", error);
    return { ok: false, message: "Could not delete category." };
  }
  return { ok: true };
}

export async function dbUpdateExpenseCategory(expenseId, categoryId) {
  const { error } = await supabase
    .from("expenses")
    .update({ category_id: categoryId })
    .eq("id", expenseId);
  if (error) {
    console.error("dbUpdateExpenseCategory:", error);
    return { ok: false, message: "Could not update category." };
  }
  return { ok: true };
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
  const { error } = await supabase.from("expenses").delete().eq("id", expenseUuid);
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

export async function dbUpdateCurrency(code) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;
  if (!user) return { ok: false, message: "Your session has expired." };
  const { error } = await supabase
    .from("profiles")
    .update({ currency: code.toUpperCase() })
    .eq("id", user.id);
  if (error) {
    console.error("dbUpdateCurrency:", error);
    return { ok: false, message: "Could not save currency preference." };
  }
  return { ok: true };
}

export async function dbUpdatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    console.error("dbUpdatePassword:", error);
    return { ok: false, ...classifyError(error) };
  }
  return { ok: true, data: undefined };
}

export async function dbExportData() {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;
  if (!user) return { ok: false, message: "Your session has expired." };

  const [monthsResult, catsResult] = await Promise.all([
    supabase
      .from("months")
      .select("*, expenses(*)")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("year", { ascending: false })
      .order("month", { ascending: false }),
    supabase
      .from("categories")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true }),
  ]);

  if (monthsResult.error) return { ok: false, message: "Export failed — could not fetch months." };
  if (catsResult.error)   return { ok: false, message: "Export failed — could not fetch categories." };

  return {
    ok: true,
    data: {
      exported_at: new Date().toISOString(),
      user_id: user.id,
      categories: catsResult.data || [],
      months: (monthsResult.data || []).map((m) => ({
        id: m.id,
        name: m.name,
        year: m.year,
        month: m.month,
        budget: m.budget,
        created_at: m.created_at,
        expenses: (m.expenses || []).map((e) => ({
          id: e.id,
          description: e.description,
          amount: e.amount,
          expense_date: e.expense_date,
          category_id: e.category_id,
          created_at: e.created_at,
        })),
      })),
    },
  };
}

export async function dbUpdateLifetimeOffset(dollars) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;
  if (!user) return { ok: false, message: "Your session has expired." };
  const { error } = await supabase
    .from("profiles")
    .update({ lifetime_offset: dollars })
    .eq("id", user.id);
  if (error) {
    console.error("dbUpdateLifetimeOffset:", error);
    return { ok: false, message: "Could not save starting figure." };
  }
  return { ok: true };
}
