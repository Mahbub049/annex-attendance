const API_BASE_URL = "https://course-management-server-1l1s.onrender.com/api";
const AUTH_KEY = "bap_server_auth_v1";

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

async function handleRequest(message) {
  switch (message?.type) {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type?.startsWith("BAP_")) return undefined;

  handleRequest(message)
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
