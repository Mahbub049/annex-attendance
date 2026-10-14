const API_BASE_URL = "https://course-management-server-1l1s.onrender.com/api";
const AUTH_KEY = "bap_server_auth_v1";
const UI_STATE_PREFIX = "bap_ui_state_tab_v2_";

function stateKeyFor(sender) {
  const id = sender?.tab?.id;
  if (!Number.isInteger(id)) throw new Error("Attendance Assistant tab was not available.");
  return `${UI_STATE_PREFIX}${id}`;
}

async function getStoredAuth() {
  const saved = await chrome.storage.local.get(AUTH_KEY);
  return saved?.[AUTH_KEY] || null;
}

async function saveAuth(auth) {
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
}

async function clearAuth() {
  await chrome.storage.local.remove(AUTH_KEY);
}

async function apiFetch(path, { method = "GET", body, token, timeout = 180000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let data = null;
    let rawText = "";
    try {
      rawText = await response.text();
      data = rawText ? JSON.parse(rawText) : null;
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      let message = data?.message || `Request failed (${response.status})`;
      if (response.status === 500 && !data?.message) {
        message = "Marks Portal server returned HTTP 500. Make sure the deployed server allows chrome-extension:// requests.";
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function warmUpApi() {
  try {
    await apiFetch("/health", { timeout: 90000 });
  } catch (_) {
    // Login itself will provide the useful error if the hosted API is unavailable.
  }
}

async function requireAuth() {
  const auth = await getStoredAuth();
  if (!auth?.token) {
    const error = new Error("Please log in to Marks Portal first.");
    error.status = 401;
    throw error;
  }
  return auth;
}

async function handleRequest(message, sender) {
  switch (message?.type) {
    case "BAP_GET_UI_STATE": {
      const key = stateKeyFor(sender);
      return (await chrome.storage.session.get(key))[key] || null;
    }

    case "BAP_SET_UI_STATE": {
      const key = stateKeyFor(sender);
      const ui = message?.state;
      if (!ui || ui.version !== 2) throw new Error("Invalid attendance assistant UI state.");
      // Do not store passwords, bearer tokens, student roll lists, or attendance in UI state.
      const safe = {
        version: 2,
        username: String(ui.username || "").slice(0, 160),
        panelOpen: Boolean(ui.panelOpen),
        intake: String(ui.intake || "").slice(0, 80),
        section: String(ui.section || "").slice(0, 80),
        courseId: String(ui.courseId || "").slice(0, 160),
        activeSessionKey: String(ui.activeSessionKey || "").slice(0, 200),
        dateFrom: String(ui.dateFrom || "").slice(0, 12),
        dateTo: String(ui.dateTo || "").slice(0, 12),
        expandedDates: (Array.isArray(ui.expandedDates) ? ui.expandedDates : []).slice(0, 200).map((d) => String(d).slice(0, 12)),
        scrollTop: Math.max(0, Math.min(100000, Number(ui.scrollTop) || 0)),
        autoRefreshAfterSubmit: ui.autoRefreshAfterSubmit !== false,
      };
      await chrome.storage.session.set({ [key]: safe });
      return { saved: true };
    }

    case "BAP_CLEAR_UI_STATE": {
      await chrome.storage.session.remove(stateKeyFor(sender));
      return { cleared: true };
    }

    case "BAP_LOGIN": { 
      await warmUpApi();
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: {
          username: String(message.username || "").trim(),
          password: String(message.password || ""),
          rememberMe: false,
        },
      });

      if (data?.role !== "teacher") {
        await clearAuth();
        const error = new Error("This attendance assistant is available for teacher accounts only.");
        error.status = 403;
        throw error;
      }

      const auth = {
        token: data.token,
        profile: {
          role: data.role,
          name: data.name || "Course Teacher",
          username: data.username || "",
          shortCode: data.shortCode || "",
          designation: data.designation || "",
          department: data.department || "",
        },
      };
      await saveAuth(auth);
      return { profile: auth.profile };
    }

    case "BAP_GET_SESSION": {
      const auth = await getStoredAuth();
      if (!auth?.token) return { loggedIn: false };
      try {
        const profile = await apiFetch("/auth/profile", { token: auth.token });
        if (profile?.role !== "teacher") {
          await clearAuth();
          return { loggedIn: false };
        }
        const nextAuth = { ...auth, profile };
        await saveAuth(nextAuth);
        return { loggedIn: true, profile };
      } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
          await clearAuth();
          return { loggedIn: false, expired: true };
        }
        throw error;
      }
    }

    case "BAP_LOGOUT":
      await clearAuth();
      return { ok: true };

    case "BAP_GET_COURSES": {
      const auth = await requireAuth();
      return apiFetch("/courses?archived=false", { token: auth.token });
    }

    case "BAP_GET_ATTENDANCE_SHEET": {
      const auth = await requireAuth();
      const courseId = encodeURIComponent(String(message.courseId || ""));
      if (!courseId) throw new Error("Course is required.");
      return apiFetch(`/attendance/sheet?courseId=${courseId}`, { token: auth.token });
    }

    default:
      throw new Error("Unknown extension request.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith("BAP_")) return undefined;

  handleRequest(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.name === "AbortError" ? "Marks Portal server timed out." : (error?.message || "Request failed."),
        status: Number(error?.status || 0),
      });
    });

  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !/^https?:\/\/annex\.bubt\.edu\.bd\//i.test(tab.url || "")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "BAP_TOGGLE_PANEL" });
  } catch (_) {
    // Content script becomes available after the Annex page finishes loading.
  }
});

// Keep extension UI state only while its Annex tab exists; avoid cross-tab mixups.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`${UI_STATE_PREFIX}${tabId}`).catch(() => {});
});
