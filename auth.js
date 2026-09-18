import { supabase } from "./supabase-client.js";
import {
  state,
  setState,
  setActiveMonthId,
  clearSession,
  writeLocalCache,
  readLocalCache,
  setCurrentUserId,
  getCurrentUserId,
} from "./state.js";
import { loadState } from "./api.js";

// Imported lazily by app.js to avoid circular deps — these are set via init callbacks
let _showScreen = null;
let _showBanner = null;
let _renderHistory = null;
let _renderWelcomeName = null;
let _sortMonths = null;

export function registerAuthCallbacks({
  showScreen,
  showBanner,
  renderHistory,
  renderWelcomeName,
  sortMonths,
}) {
  _showScreen = showScreen;
  _showBanner = showBanner;
  _renderHistory = renderHistory;
  _renderWelcomeName = renderWelcomeName;
  _sortMonths = sortMonths;
}

export function handleSessionInvalid(errorCode) {
  clearSession();
  setCurrentUserId(null);
  setState({ displayName: null, months: [] });
  setActiveMonthId(null);
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  _showScreen && _showScreen("login");
  if (errorCode === "ACCOUNT_INACTIVE") {
    _showBanner &&
      _showBanner(
        "login-error",
        "Your account has been deactivated. Contact support.",
      );
  } else {
    _showBanner &&
      _showBanner(
        "login-error",
        "Your session has expired. Please log in again.",
      );
  }
}

export async function doLogin() {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData && userData.user;
  if (!user) {
    handleSessionInvalid("SESSION_INVALID");
    throw new Error("SESSION_INVALID");
  }
  setCurrentUserId(user.id);

  try {
    const loaded = await loadState();
    setState(loaded);
    writeLocalCache(state);
  } catch (err) {
    if (err.kind === "auth") {
      handleSessionInvalid("SESSION_INVALID");
      throw new Error("SESSION_INVALID");
    }
    throw err;
  }

  _sortMonths && _sortMonths();
  _renderHistory && _renderHistory();
  _renderWelcomeName && (await _renderWelcomeName());
  _showScreen && _showScreen("history");
}

export async function signInWithPassword(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error || null; // null = success
}

let _isSigningOut = false;

export async function signOut() {
  _isSigningOut = true;
  await supabase.auth.signOut();
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event !== "SIGNED_OUT") return;
  if (_isSigningOut) {
    _isSigningOut = false;
    return;
  }
  if (getCurrentUserId() === null) return; // nothing was logged in — nothing to invalidate
  handleSessionInvalid("SESSION_INVALID");
});

export async function getSession() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
}
