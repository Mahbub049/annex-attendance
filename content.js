(() => {
  if (window.top !== window) return;
  if (window.__BAP_V1_LOADED__) return;
  window.__BAP_V1_LOADED__ = true;

  const state = {
    panelOpen: false,
    authChecked: false,
    profile: null,
    courses: [],
    selectedCourseId: "",
    attendance: null,
    activeSessionKey: "",
    expandedDates: new Set(),
    busy: false,
    log: [],
    restoreSnapshot: null,
    restoring: true,
    autoRefreshAfterSubmit: true,
    scrollTop: 0,
    pendingSubmit: null,
    reloadStarted: false,
  };

  // This is per-tab extension session state (not an Annex cookie or a Marks Portal token).
  // The session is reconstructed whenever Annex performs a full document navigation.
  let saveTimer = null;
  let formMonitor = null;
  let successCheckTimer = null;
  const SAVE_DELAY_MS = 170;
  const SUCCESS_TEXT = /(?:attendance\s+(?:submitted|saved|added)\s+successfully|(?:successfully\s+(?:submitted|saved|added)\s+attendance))/i;

  const txt = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const low = (v) => txt(v).toLowerCase();
  const normId = (v) => txt(v).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function normalizeCourseCode(value) {
    const raw = txt(value).toUpperCase();
    const match = raw.match(/\b([A-Z]{2,8})\s*-?\s*(\d{3,4}[A-Z]?)\b/);
    return match ? `${match[1]}-${match[2]}` : raw.replace(/\s+/g, "");
  }

  function normalizeSmallNumber(value) {
    const match = txt(value).match(/\d+/);
    return match ? String(Number(match[0])) : "";
  }

  function addLog(message) {
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    state.log.push(`${stamp}  ${message}`);
    if (state.log.length > 40) state.log.shift();
    renderLog();
  }

  async function send(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) {
      const error = new Error(response?.error || "Extension request failed.");
      error.status = response?.status || 0;
      throw error;
    }
    return response.data;
  }

  function getUiSnapshot() {
    const intake = document.getElementById("bap-intake-filter");
    const section = document.getElementById("bap-section-filter");
    const course = document.getElementById("bap-course-filter");
    const list = document.querySelector("#bap-body .bap-scroll");
    return {
      version: 2,
      username: state.profile?.username || state.restoreSnapshot?.username || "",
      panelOpen: state.panelOpen,
      intake: intake?.value ?? state.restoreSnapshot?.intake ?? "",
      section: section?.value ?? state.restoreSnapshot?.section ?? "",
      courseId: course?.value ?? state.selectedCourseId ?? "",
      activeSessionKey: state.activeSessionKey,
      dateFrom: document.getElementById("bap-date-from")?.value ?? state.restoreSnapshot?.dateFrom ?? "",
      dateTo: document.getElementById("bap-date-to")?.value ?? state.restoreSnapshot?.dateTo ?? "",
      expandedDates: [...state.expandedDates],
      scrollTop: list?.scrollTop ?? state.scrollTop,
      autoRefreshAfterSubmit: state.autoRefreshAfterSubmit,
    };
  }

  async function persistUiStateNow() {
    if (state.restoring) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      await send("BAP_SET_UI_STATE", { state: getUiSnapshot() });
    } catch (error) {
      // A temporary storage error must never interrupt manual Annex attendance work.
      addLog(`Could not save drawer preferences: ${error?.message || error}`);
    }
  }

  function scheduleSaveUiState() {
    if (state.restoring || state.reloadStarted) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persistUiStateNow(); }, SAVE_DELAY_MS);
  }

  async function restoreUiState() {
    try {
      const saved = await send("BAP_GET_UI_STATE");
      if (!saved || saved.version !== 2) return;
      state.restoreSnapshot = saved;
      state.panelOpen = Boolean(saved.panelOpen);
      state.selectedCourseId = String(saved.courseId || "");
      state.activeSessionKey = String(saved.activeSessionKey || "");
      state.expandedDates = new Set(Array.isArray(saved.expandedDates) ? saved.expandedDates : []);
      state.scrollTop = Math.max(0, Number(saved.scrollTop) || 0);
      state.autoRefreshAfterSubmit = saved.autoRefreshAfterSubmit !== false;
    } catch (_) {
      // The extension is still usable if persistent session storage is unavailable.
    }
  }

  function restoreAppFields() {
    const snapshot = state.restoreSnapshot;
    if (!snapshot) return;
    const from = document.getElementById("bap-date-from");
    const to = document.getElementById("bap-date-to");
    const checkbox = document.getElementById("bap-auto-refresh");
    if (from) from.value = snapshot.dateFrom || "";
    if (to) to.value = snapshot.dateTo || "";
    if (checkbox) checkbox.checked = state.autoRefreshAfterSubmit;
    const scroller = document.querySelector("#bap-body .bap-scroll");
    if (scroller) scroller.scrollTop = state.scrollTop;
  }

  function isExtensionNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest?.("#bap-panel, #bap-launcher"));
  }

  function successNodeInAnnex(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element || isExtensionNode(element)) return false;
    const text = txt(element.textContent);
    return text.length <= 240 && SUCCESS_TEXT.test(text);
  }

  // Only react to a NEW confirmation after an actual user click on Annex Submit.
  // A pre-existing 'submitted successfully' label never triggers a refresh by itself.
  function isFreshSuccessMutation(mutation) {
    if (isExtensionNode(mutation.target)) return false;
    if (mutation.type === "characterData" && successNodeInAnnex(mutation.target)) return true;
    if (mutation.type !== "childList") return false;
    if ([...mutation.addedNodes].some((node) => {
      if (successNodeInAnnex(node)) return true;
      if (node.nodeType !== Node.ELEMENT_NODE || isExtensionNode(node)) return false;
      return Boolean([...node.querySelectorAll("div, p, span, small, td, strong, label")].find(successNodeInAnnex));
    })) return true;
    // Some Annex code rewrites only the text inside an existing success container.
    return successNodeInAnnex(mutation.target) && mutation.addedNodes.length > 0;
  }

  function isAnnexSubmitControl(element) {
    const control = element?.closest?.('button, input[type="submit"], input[type="button"]');
    if (!control || isExtensionNode(control)) return false;
    const text = low([control.textContent, control.value, control.name, control.id].filter(Boolean).join(" "));
    return /\bsubmit\b|\bsave\s+attendance\b/.test(text);
  }

  function beginAnnexSubmitWatch() {
    if (!state.profile || !state.selectedCourseId || state.busy || state.reloadStarted) return;
    if (state.pendingSubmit?.timer) clearTimeout(state.pendingSubmit.timer);
    const started = Date.now();
    const pending = { started, timer: null, confirmed: false };
    pending.timer = setTimeout(() => {
      if (state.pendingSubmit === pending) state.pendingSubmit = null;
    }, 45000);
    state.pendingSubmit = pending;
    scheduleSaveUiState();
    addLog("Annex Submit detected; waiting for Annex success confirmation.");
  }

  async function confirmAnnexSubmission() {
    const pending = state.pendingSubmit;
    if (!pending || pending.confirmed || state.reloadStarted) return;
    if (Date.now() - pending.started > 45000) return;
    pending.confirmed = true;
    clearTimeout(pending.timer);
    state.pendingSubmit = null;
    addLog("Annex confirmed successful submission.");
    if (!state.autoRefreshAfterSubmit) {
      setStatus("ok", "Annex confirmed the attendance. You can fill another date, or refresh Annex using the button below.");
      return;
    }
    setStatus("working", "Attendance saved in Annex. Refreshing Annex and restoring your selection…");
    await refreshAnnex({ reason: "confirmed submit" });
  }

  async function refreshAnnex({ reason = "manual" } = {}) {
    if (state.reloadStarted) return;
    if (state.busy) {
      setStatus("bad", "Please wait until the current fill finishes before refreshing Annex.");
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    // Save before changing documents. Otherwise selection, active date and scroll position are lost.
    await persistUiStateNow();
    state.reloadStarted = true;
    addLog(`Refreshing Annex (${reason}) while keeping the assistant session.`);
    window.location.reload();
  }

  function installAnnexSubmitMonitor() {
    document.addEventListener("click", (event) => {
      if (isAnnexSubmitControl(event.target)) beginAnnexSubmitWatch();
      else if (state.panelOpen && !isExtensionNode(event.target)) {
        // Clicking the page away from Submit closes the drawer, as does the X button.
        togglePanel(false);
      }
    }, true);
    document.addEventListener("submit", (event) => {
      if (!isExtensionNode(event.target) && !state.pendingSubmit) beginAnnexSubmitWatch();
    }, true);

    formMonitor = new MutationObserver((mutations) => {
      if (!state.pendingSubmit || !state.autoRefreshAfterSubmit) return;
      if (mutations.some(isFreshSuccessMutation)) {
        if (successCheckTimer) clearTimeout(successCheckTimer);
        successCheckTimer = setTimeout(confirmAnnexSubmission, 160);
      }
    });
    formMonitor.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }

  function labelTextFor(el) {
    if (!el) return "";
    const labels = [];
    if (el.id) {
      document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach((label) => labels.push(txt(label.textContent)));
    }
    const parent = el.closest("label");
    if (parent) labels.push(txt(parent.textContent));
    return labels.join(" ");
  }

  function signature(el) {
    if (!el) return "";
    const pieces = [
      el.id,
      el.name,
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("placeholder"),
      labelTextFor(el),
    ];
    if (el.tagName === "SELECT") {
      pieces.push(...Array.from(el.options || []).slice(0, 30).map((option) => txt(option.textContent)));
    }
    return low(pieces.filter(Boolean).join(" | "));
  }

  // Never mistake the assistant's own filters for Annex form controls.
  function annexElements(selector) {
    return Array.from(document.querySelectorAll(selector)).filter((element) => !isExtensionNode(element));
  }

  function firstAnnexElement(selector) {
    return annexElements(selector)[0] || null;
  }

  function allSelects() {
    return annexElements("select");
  }

  function findCourseControl() {
    const selects = allSelects();
    return selects.find((select) => /select\s*course|course/.test(signature(select)) &&
      Array.from(select.options || []).some((option) => /\b[A-Z]{2,8}\s*-?\s*\d{3,4}\b/i.test(txt(option.textContent))))
      || selects.find((select) => Array.from(select.options || []).filter((option) => /\b[A-Z]{2,8}\s*-?\s*\d{3,4}\b/i.test(txt(option.textContent))).length >= 2)
      || firstAnnexElement('input[placeholder*="Course" i], input[name*="course" i], input[id*="course" i]');
  }

  function findIntakeControl() {
    return allSelects().find((select) => /intake/.test(signature(select)))
      || firstAnnexElement('input[placeholder*="Intake" i], input[name*="intake" i], input[id*="intake" i]');
  }

  function findSectionControl() {
    return allSelects().find((select) => /section/.test(signature(select)))
      || firstAnnexElement('input[placeholder*="Section" i], input[name*="section" i], input[id*="section" i]');
  }

  function findPeriodControl() {
    return allSelects().find((select) => /no\s*of\s*class|number\s*of\s*class|period/.test(signature(select)))
      || firstAnnexElement('input[placeholder*="No of Class" i], input[name*="class" i], input[id*="class" i], input[type="number"]');
  }

  function findDateControl() {
    return firstAnnexElement('input[type="date"]')
      || annexElements("input").find((input) => /date/.test(signature(input)));
  }

  function scanForm() {
    const controls = {
      course: findCourseControl(),
      intake: findIntakeControl(),
      section: findSectionControl(),
      date: findDateControl(),
      period: findPeriodControl(),
    };
    const bodyText = low(document.body?.innerText || "");
    const detected = bodyText.includes("new attendance") && Object.values(controls).every(Boolean);
    return { detected, controls };
  }

  function optionValues(select) {
    if (!select || select.tagName !== "SELECT") return [];
    return Array.from(select.options || []).filter((option) => !option.disabled).map((option) => ({
      value: option.value,
      text: txt(option.textContent),
    }));
  }

  function dispatch(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  async function waitFor(fn, timeout = 7000, interval = 120) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = fn();
        if (result) return result;
      } catch (_) {}
      await sleep(interval);
    }
    return null;
  }

  async function setSelectOption(select, matcher, description) {
    if (!select || select.tagName !== "SELECT") {
      throw new Error(`${description} dropdown was not found as a native select.`);
    }
    const option = Array.from(select.options || []).find((item) => matcher(txt(item.textContent), item.value, item));
    if (!option) throw new Error(`${description} option was not found in Annex.`);
    if (select.value !== option.value) {
      select.value = option.value;
      option.selected = true;
      dispatch(select, "input");
      dispatch(select, "change");
      await sleep(320);
    }
    addLog(`${description}: ${txt(option.textContent)}`);
    return option;
  }

  async function setCourse(targetCode) {
    const normalized = normalizeCourseCode(targetCode);
    const select = await waitFor(() => {
      const control = findCourseControl();
      if (control?.tagName !== "SELECT") return null;
      return optionValues(control).some((option) => normalizeCourseCode(option.text) === normalized) ? control : null;
    });
    if (!select) throw new Error(`Could not find ${normalized} in the Annex Course dropdown.`);
    await setSelectOption(select, (text) => normalizeCourseCode(text) === normalized, "Course");
  }

  async function setIntakeAndSection(targetIntake, targetSection) {
    const intakeWanted = normalizeSmallNumber(targetIntake);
    const sectionWanted = normalizeSmallNumber(targetSection);
    if (!sectionWanted) throw new Error("Selected Marks Portal course does not have a valid section.");

    const intake = await waitFor(() => {
      const control = findIntakeControl();
      return control?.tagName === "SELECT" && optionValues(control).length > 1 ? control : null;
    });
    if (!intake) throw new Error("Annex Intake dropdown did not become available.");

    if (intakeWanted) {
      await setSelectOption(intake, (text) => normalizeSmallNumber(text) === intakeWanted, "Intake");
    }

    const section = await waitFor(() => {
      const control = findSectionControl();
      if (control?.tagName !== "SELECT") return null;
      return optionValues(control).some((option) => normalizeSmallNumber(option.text) === sectionWanted) ? control : null;
    }, 6000);

    if (!section) throw new Error(`Section ${sectionWanted} was not found in Annex for the selected course/intake.`);
    await setSelectOption(section, (text) => normalizeSmallNumber(text) === sectionWanted, "Section");
  }

  async function setDate(dateIso) {
    const input = await waitFor(() => findDateControl(), 3000);
    if (!input) throw new Error("Annex date field was not found.");
    input.value = dateIso;
    dispatch(input, "input");
    dispatch(input, "change");
    addLog(`Date: ${dateIso}`);
    await sleep(220);
  }

  async function setPeriod(value) {
    const control = await waitFor(() => findPeriodControl(), 3000);
    if (!control) throw new Error("Annex Select No of Class field was not found.");
    const target = String(Number(value));
    if (control.tagName === "SELECT") {
      await setSelectOption(control, (text, optionValue) => normalizeSmallNumber(text || optionValue) === target, "No. of Class");
    } else {
      control.value = target;
      dispatch(control, "input");
      dispatch(control, "change");
      addLog(`No. of Class: ${target}`);
      await sleep(250);
    }
  }

  function findAttendanceTable() {
    for (const table of Array.from(document.querySelectorAll("table"))) {
      const rows = Array.from(table.querySelectorAll("tr"));
      for (let rowIndex = 0; rowIndex < Math.min(rows.length, 6); rowIndex += 1) {
        const cells = Array.from(rows[rowIndex].querySelectorAll("th,td")).map((cell) => low(cell.innerText || cell.textContent));
        const idIndex = cells.findIndex((value) => value.includes("student id") || value === "id" || value.includes("studentid"));
        const nameIndex = cells.findIndex((value) => value === "name" || value.includes("student name"));
        if (idIndex >= 0 && nameIndex >= 0) return { table, rows, headerIndex: rowIndex, idIndex, nameIndex };
      }
    }
    return null;
  }

  function extractAnnexStudents() {
    const info = findAttendanceTable();
    if (!info) return [];
    const students = [];
    for (const row of info.rows.slice(info.headerIndex + 1)) {
      const cells = Array.from(row.querySelectorAll("td,th"));
      if (cells.length <= Math.max(info.idIndex, info.nameIndex)) continue;
      const id = txt(cells[info.idIndex]?.innerText || cells[info.idIndex]?.textContent);
      if (!id || !/\d{4,}/.test(id.replace(/\D/g, ""))) continue;
      students.push({
        id,
        key: normId(id),
        name: txt(cells[info.nameIndex]?.innerText || cells[info.nameIndex]?.textContent),
        checkbox: row.querySelector('input[type="checkbox"]'),
        row,
      });
    }
    return students;
  }

  async function waitForStudentRows() {
    return waitFor(() => {
      const rows = extractAnnexStudents();
      return rows.length ? rows : null;
    }, 8000, 150);
  }

  function setCheckboxValue(checkbox, checked) {
    if (!checkbox) return;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
    if (descriptor?.set) descriptor.set.call(checkbox, Boolean(checked));
    else checkbox.checked = Boolean(checked);
    dispatch(checkbox, "input");
    dispatch(checkbox, "change");
  }

  function applyAttendanceSession(session) {
    const annexStudents = extractAnnexStudents();
    if (!annexStudents.length) throw new Error("Annex student table did not load for this attendance.");
    if (!state.attendance?.students || !state.attendance?.matrix) throw new Error("Marks Portal attendance is not loaded.");

    const rollByKey = new Map(state.attendance.students.map((student) => [normId(student.roll), String(student.roll)]));
    let matched = 0;
    let present = 0;
    let absent = 0;
    let unknown = 0;
    let missing = 0;

    for (const student of annexStudents) {
      const roll = rollByKey.get(student.key);
      if (!roll) {
        missing += 1;
        continue;
      }
      matched += 1;
      const value = state.attendance.matrix?.[roll]?.[session.key];
      if (value === true) {
        setCheckboxValue(student.checkbox, true);
        present += 1;
      } else if (value === false) {
        setCheckboxValue(student.checkbox, false);
        absent += 1;
      } else {
        unknown += 1;
      }
    }

    addLog(`Filled ${session.date} P${session.period}: ${present} present, ${absent} absent, ${matched}/${annexStudents.length} matched.`);
    return { annexCount: annexStudents.length, matched, present, absent, unknown, missing };
  }

  function getSelectedCourse() {
    return state.courses.find((course) => String(course.id) === String(state.selectedCourseId)) || null;
  }

  async function ensureBaseSelection() {
    const course = getSelectedCourse();
    if (!course) throw new Error("Select a Marks Portal course first.");
    const scan = scanForm();
    if (!scan.detected) {
      throw new Error("Open Annex → New Attendance first. Course, Intake, Section, Date and No. of Class must be visible.");
    }
    await setCourse(course.code);
    await setIntakeAndSection(course.intake, course.section);
  }

  function getFilteredSessions() {
    const sessions = Array.isArray(state.attendance?.sessions) ? state.attendance.sessions : [];
    const from = document.getElementById("bap-date-from")?.value || "";
    const to = document.getElementById("bap-date-to")?.value || "";
    return sessions.filter((session) => (!from || session.date >= from) && (!to || session.date <= to));
  }

  function sessionSignature(session) {
    if (!state.attendance?.students || !state.attendance?.matrix) return "";
    return state.attendance.students.map((student) => {
      const value = state.attendance.matrix?.[student.roll]?.[session.key];
      return `${student.roll}:${value === true ? 1 : value === false ? 0 : "x"}`;
    }).join("|");
  }

  function groupSessionsByDate(sessions) {
    const groups = new Map();
    sessions.forEach((session) => {
      if (!groups.has(session.date)) groups.set(session.date, []);
      groups.get(session.date).push(session);
    });
    return Array.from(groups, ([date, items]) => ({
      date,
      sessions: items.sort((a, b) => Number(a.period) - Number(b.period)),
      identical: items.length > 1 && items.every((item) => sessionSignature(item) === sessionSignature(items[0])),
    }));
  }

  async function fillSession(session) {
    if (state.busy || !session) return;
    setBusy(true);
    setStatus("working", `Filling ${session.date} · Period ${session.period}…`);
    try {
      await ensureBaseSelection();
      await setDate(session.date);
      await setPeriod(session.period);
      await sleep(250);
      const rows = await waitForStudentRows();
      if (!rows) throw new Error("Annex student list did not load after selecting the attendance.");
      const result = applyAttendanceSession(session);
      state.activeSessionKey = session.key;
      scheduleSaveUiState();
      renderAttendanceList();
      setStatus("ok", `${session.date} · Period ${session.period} is filled on-screen. ${result.present} Present, ${result.absent} Absent. Review it, then use Annex Submit yourself.`);
    } catch (error) {
      handleActionError(error, "Could not fill this attendance.");
    } finally {
      setBusy(false);
    }
  }

  async function fillDateGroup(group) {
    if (state.busy || !group?.sessions?.length) return;
    if (!group.identical) {
      setStatus("bad", "These periods do not have identical attendance. Open the date and fill each period separately.");
      return;
    }

    setBusy(true);
    setStatus("working", `Filling ${group.date} as ${group.sessions.length} periods…`);
    try {
      await ensureBaseSelection();
      await setDate(group.date);
      await setPeriod(group.sessions.length);
      await sleep(250);
      const rows = await waitForStudentRows();
      if (!rows) throw new Error("Annex student list did not load after selecting the attendance.");
      const result = applyAttendanceSession(group.sessions[0]);
      state.activeSessionKey = group.sessions[group.sessions.length - 1].key;
      scheduleSaveUiState();
      renderAttendanceList();
      setStatus("ok", `${group.date} is filled as ${group.sessions.length} periods because the selected periods have the same attendance. ${result.present} Present, ${result.absent} Absent. Submit manually in Annex after checking.`);
    } catch (error) {
      handleActionError(error, "Could not fill these periods together.");
    } finally {
      setBusy(false);
    }
  }

  async function fillNextAttendance() {
    const sessions = getFilteredSessions();
    if (!sessions.length) {
      setStatus("bad", "No attendance is available in the selected date range.");
      return;
    }
    let index = sessions.findIndex((session) => session.key === state.activeSessionKey);
    index = index < 0 ? 0 : index + 1;
    if (index >= sessions.length) {
      setStatus("ok", "You have reached the last attendance in this filtered list.");
      return;
    }
    await fillSession(sessions[index]);
  }

  function handleActionError(error, fallback) {
    addLog(`ERROR: ${error?.message || error}`);
    if (Number(error?.status || 0) === 401) {
      state.profile = null;
      state.authChecked = true;
      state.courses = [];
      state.attendance = null;
      renderApp();
      showLoginError("Your Marks Portal session expired. Please log in again.");
      return;
    }
    setStatus("bad", error?.message || fallback);
  }

  function setBusy(value) {
    state.busy = value;
    document.querySelectorAll("#bap-panel button, #bap-panel select, #bap-panel input").forEach((control) => {
      if (control.id === "bap-close") return;
      if (value) {
        control.dataset.bapDisabledBeforeBusy = control.disabled ? "1" : "0";
        control.disabled = true;
      } else if (Object.prototype.hasOwnProperty.call(control.dataset, "bapDisabledBeforeBusy")) {
        control.disabled = control.dataset.bapDisabledBeforeBusy === "1";
        delete control.dataset.bapDisabledBeforeBusy;
      }
    });
    if (!value && state.attendance) renderAttendanceList();
  }

  function setStatus(kind, message) {
    const el = document.getElementById("bap-status");
    if (!el) return;
    el.className = `bap-state ${kind === "working" ? "warn" : kind}`;
    el.textContent = message;
  }

  function renderLog() {
    const el = document.getElementById("bap-log");
    if (!el) return;
    el.textContent = state.log.length ? state.log.join("\n") : "No actions yet.";
    el.scrollTop = el.scrollHeight;
  }

  function renderFormState() {
    const el = document.getElementById("bap-form-state");
    if (!el) return;
    const scan = scanForm();
    if (scan.detected) {
      el.className = "bap-inline-state ok";
      el.textContent = "Ready · Annex New Attendance detected";
    } else {
      el.className = "bap-inline-state bad";
      el.textContent = "Not ready · Open Annex → New Attendance";
    }
  }

  function courseLabel(course) {
    const code = course.code || "Course";
    const title = course.title ? ` · ${course.title}` : "";
    return `${code}${title}`;
  }

  function uniqueSorted(values) {
    return Array.from(new Set(values.filter(Boolean).map((value) => txt(value)))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  function setOptions(select, values, placeholder, selectedValue = "") {
    if (!select) return;
    select.innerHTML = `<option value="">${esc(placeholder)}</option>` + values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
    if (values.includes(selectedValue)) select.value = selectedValue;
  }

  function refreshCourseFilters({ preserve = true, restore = null } = {}) {
    const intakeSelect = document.getElementById("bap-intake-filter");
    const sectionSelect = document.getElementById("bap-section-filter");
    const courseSelect = document.getElementById("bap-course-filter");
    if (!intakeSelect || !sectionSelect || !courseSelect) return;

    const previousIntake = restore ? String(restore.intake || "") : preserve ? intakeSelect.value : "";
    const previousSection = restore ? String(restore.section || "") : preserve ? sectionSelect.value : "";
    const previousCourse = restore ? String(restore.courseId || "") : preserve ? courseSelect.value : state.selectedCourseId;

    const intakes = uniqueSorted(state.courses.map((course) => course.intake || ""));
    setOptions(intakeSelect, intakes, "Select intake", previousIntake);

    const intake = intakeSelect.value;
    const byIntake = state.courses.filter((course) => !intake || txt(course.intake) === intake);
    const sections = uniqueSorted(byIntake.map((course) => course.section || ""));
    setOptions(sectionSelect, sections, "Select section", previousSection);

    const section = sectionSelect.value;
    const available = byIntake.filter((course) => !section || txt(course.section) === section);
    courseSelect.innerHTML = '<option value="">Select course</option>' + available.map((course) =>
      `<option value="${esc(course.id)}">${esc(courseLabel(course))}</option>`).join("");

    if (available.some((course) => String(course.id) === String(previousCourse))) {
      courseSelect.value = previousCourse;
    }

    state.selectedCourseId = courseSelect.value || "";
  }

  async function loadCourses() {
    setStatus("working", "Loading your Marks Portal courses…");
    try {
      const courses = await send("BAP_GET_COURSES");
      state.courses = Array.isArray(courses) ? courses : [];
      const saved = state.restoreSnapshot;
      const sameUser = !saved?.username || saved.username === state.profile?.username;
      if (saved && !sameUser) {
        state.restoreSnapshot = null;
        state.selectedCourseId = "";
        state.activeSessionKey = "";
        state.expandedDates.clear();
      }
      refreshCourseFilters({ preserve: false, restore: sameUser ? saved : null });
      if (state.selectedCourseId) {
        await loadAttendance(state.selectedCourseId, { preserveActive: true });
        const scroller = document.querySelector("#bap-body .bap-scroll");
        if (scroller && saved) {
          state.scrollTop = Math.max(0, Number(saved.scrollTop) || 0);
          scroller.scrollTop = state.scrollTop;
        }
        addLog("Course, filters and last attendance restored after Annex refresh.");
      } else {
        setStatus("ok", state.courses.length ? "Choose Intake → Section → Course. Your choices will be kept when Annex refreshes." : "No active courses were found for this teacher account.");
      }
      state.restoring = false;
      state.restoreSnapshot = null;
      scheduleSaveUiState();
    } catch (error) {
      handleActionError(error, "Could not load courses.");
    } finally {
      state.restoring = false;
    }
  }

  async function loadAttendance(courseId, { preserveActive = false } = {}) {
    if (!courseId) {
      state.attendance = null;
      state.selectedCourseId = "";
      renderAttendanceList();
      return;
    }
    if (String(state.selectedCourseId) !== String(courseId) || !preserveActive) {
      state.activeSessionKey = "";
    }
    state.selectedCourseId = courseId;
    scheduleSaveUiState();
    setStatus("working", "Loading attendance from Marks Portal…");
    try {
      const sheet = await send("BAP_GET_ATTENDANCE_SHEET", { courseId });
      state.attendance = sheet;
      renderAttendanceSummary();
      renderAttendanceList();
      const count = sheet?.sessions?.length || 0;
      setStatus("ok", count ? `${count} saved period attendance record(s) loaded. Pick any row to fill Annex, or use Fill Next Attendance.` : "This course does not have saved attendance yet.");
      addLog(`Loaded ${courseLabel(getSelectedCourse() || {})}: ${sheet?.students?.length || 0} students, ${count} sessions.`);
    } catch (error) {
      state.attendance = null;
      renderAttendanceSummary();
      renderAttendanceList();
      handleActionError(error, "Could not load attendance.");
    }
  }

  function renderAttendanceSummary() {
    const el = document.getElementById("bap-attendance-meta");
    if (!el) return;
    if (!state.attendance) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    const course = state.attendance.course || getSelectedCourse() || {};
    const items = [
      ["Course", course.code || "—"],
      ["Intake", course.intake || "—"],
      ["Section", course.section || "—"],
      ["Students", state.attendance.students?.length ?? 0],
    ];
    el.innerHTML = items.map(([label, value]) => `<div class="bap-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
    el.style.display = "grid";
  }

  function sessionCounts(session) {
    const students = state.attendance?.students || [];
    let present = 0;
    let absent = 0;
    let unknown = 0;
    students.forEach((student) => {
      const value = state.attendance?.matrix?.[student.roll]?.[session.key];
      if (value === true) present += 1;
      else if (value === false) absent += 1;
      else unknown += 1;
    });
    return { present, absent, unknown };
  }


  function formatAttendanceDate(dateIso) {
    const match = String(dateIso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return { day: "--", monthYear: dateIso || "Date", weekday: "" };
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return {
      day: String(Number(match[3])).padStart(2, "0"),
      monthYear: date.toLocaleDateString(undefined, { month: "short", year: "numeric" }),
      weekday: date.toLocaleDateString(undefined, { weekday: "long" }),
    };
  }

  function renderAttendanceList() {
    const wrap = document.getElementById("bap-attendance-list");
    const nextButton = document.getElementById("bap-next");
    if (!wrap) return;

    const sessions = getFilteredSessions();
    if (nextButton) nextButton.disabled = state.busy || !sessions.length;

    if (!state.attendance) {
      wrap.innerHTML = `
        <div class="bap-empty-state">
          <div class="bap-empty-icon">⌁</div>
          <strong>No attendance loaded</strong>
          <span>Select a course above. Saved attendance will appear here automatically.</span>
        </div>`;
      return;
    }
    if (!sessions.length) {
      wrap.innerHTML = `
        <div class="bap-empty-state">
          <div class="bap-empty-icon">⌁</div>
          <strong>No sessions in this date range</strong>
          <span>Adjust the date filter or clear both dates to show every saved session.</span>
        </div>`;
      return;
    }

    const groups = groupSessionsByDate(sessions);
    wrap.innerHTML = groups.map((group) => {
      const isExpanded = state.expandedDates.has(group.date);
      const date = formatAttendanceDate(group.date);
      const count = group.sessions.length;
      const periodText = group.sessions.map((session) => `P${session.period}`).join(" · ");
      const combinedAction = count > 1 && group.identical
        ? `<button class="bap-session-action primary" type="button" data-fill-group="${esc(group.date)}" ${state.busy ? "disabled" : ""}>
             <span>Fill ${count} periods</span><span class="bap-action-arrow">→</span>
           </button>`
        : count === 1
          ? `<button class="bap-session-action primary" type="button" data-fill-session="${esc(group.sessions[0].key)}" ${state.busy ? "disabled" : ""}>
               <span>Fill period ${esc(group.sessions[0].period)}</span><span class="bap-action-arrow">→</span>
             </button>`
          : `<button class="bap-session-action secondary" type="button" data-toggle-date="${esc(group.date)}" ${state.busy ? "disabled" : ""}>
               <span>Choose period</span><span class="bap-action-arrow">↓</span>
             </button>`;

      const statusLabel = count === 1
        ? "Single period"
        : group.identical
          ? "Identical attendance"
          : "Period-wise only";
      const statusClass = count === 1 ? "neutral" : group.identical ? "success" : "warning";

      return `
        <article class="bap-session-card ${isExpanded ? "expanded" : ""}">
          <div class="bap-session-main">
            <div class="bap-date-block">
              <div class="bap-date-day">${esc(date.day)}</div>
              <div class="bap-date-copy">
                <strong>${esc(date.monthYear)}</strong>
                <span>${esc(date.weekday)}</span>
              </div>
            </div>

            <div class="bap-session-center">
              <div class="bap-session-status ${statusClass}"><i></i>${esc(statusLabel)}</div>
              <div class="bap-session-meta">
                <span>${count} ${count === 1 ? "period" : "periods"}</span>
                <span class="bap-meta-dot">•</span>
                <span>${esc(periodText)}</span>
              </div>
            </div>

            <div class="bap-session-actions">${combinedAction}</div>
          </div>

          ${count > 1 ? `
            <button class="bap-period-toggle" type="button" data-toggle-date="${esc(group.date)}" aria-expanded="${isExpanded}" ${state.busy ? "disabled" : ""}>
              <span class="bap-period-toggle-copy">
                <strong>Period-wise options</strong>
                <small>Open to fill an individual period instead</small>
              </span>
              <span class="bap-chevron ${isExpanded ? "open" : ""}">⌄</span>
            </button>` : ""}

          <div class="bap-period-list ${isExpanded && count > 1 ? "open" : ""}">
            <div class="bap-period-list-inner">
              ${group.sessions.map((session) => {
                const active = session.key === state.activeSessionKey;
                const counts = sessionCounts(session);
                return `
                  <div class="bap-period-row ${active ? "active" : ""}">
                    <div class="bap-period-number">P${esc(session.period)}</div>
                    <div class="bap-period-info">
                      <div class="bap-period-title">
                        <strong>Period ${esc(session.period)}</strong>
                        ${active ? '<span class="bap-row-badge">Last filled</span>' : ''}
                      </div>
                      <span>${counts.present} present · ${counts.absent} absent${counts.unknown ? ` · ${counts.unknown} unknown` : ""}</span>
                    </div>
                    <button class="bap-period-fill" type="button" data-fill-session="${esc(session.key)}" ${state.busy ? "disabled" : ""}>Fill</button>
                  </div>`;
              }).join("")}
            </div>
          </div>
        </article>`;
    }).join("");

    wrap.querySelectorAll("[data-toggle-date]").forEach((button) => button.addEventListener("click", () => {
      const date = button.dataset.toggleDate;
      const group = groups.find((item) => item.date === date);
      if (!group || group.sessions.length <= 1) return;
      if (state.expandedDates.has(date)) state.expandedDates.delete(date);
      else state.expandedDates.add(date);
      scheduleSaveUiState();
      renderAttendanceList();
    }));

    wrap.querySelectorAll("[data-fill-session]").forEach((button) => button.addEventListener("click", () => {
      const session = sessions.find((item) => item.key === button.dataset.fillSession);
      fillSession(session);
    }));

    wrap.querySelectorAll("[data-fill-group]").forEach((button) => button.addEventListener("click", () => {
      const group = groups.find((item) => item.date === button.dataset.fillGroup);
      fillDateGroup(group);
    }));
  }

  async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById("bap-username")?.value || "";
    const password = document.getElementById("bap-password")?.value || "";
    const errorEl = document.getElementById("bap-login-error");
    if (errorEl) errorEl.textContent = "";
    if (!username.trim() || !password) {
      showLoginError("Enter your Marks Portal username and password.");
      return;
    }

    setLoginBusy(true);
    try {
      const data = await send("BAP_LOGIN", { username, password });
      state.profile = data.profile;
      state.authChecked = true;
      state.courses = [];
      state.attendance = null;
      state.log = [];
      // If Annex refreshed while the token expired, restore only for the same teacher.
      const saved = state.restoreSnapshot;
      const sameUser = Boolean(saved && (!saved.username || saved.username === data.profile?.username));
      if (!sameUser) {
        state.restoreSnapshot = null;
        state.selectedCourseId = "";
        state.activeSessionKey = "";
        state.expandedDates.clear();
      }
      state.restoring = sameUser;
      renderApp();
      if (!sameUser) scheduleSaveUiState();
      addLog(`Logged in as ${state.profile?.name || username}.`);
      await loadCourses();
    } catch (error) {
      showLoginError(error?.message || "Login failed.");
    } finally {
      setLoginBusy(false);
    }
  }

  function setLoginBusy(value) {
    const button = document.getElementById("bap-login-btn");
    if (!button) return;
    button.disabled = value;
    button.textContent = value ? "Signing in…" : "Sign in to Marks Portal";
  }

  function showLoginError(message) {
    const el = document.getElementById("bap-login-error");
    if (el) el.textContent = message || "";
  }

  async function logout() {
    try { await send("BAP_LOGOUT"); } catch (_) {}
    state.profile = null;
    state.courses = [];
    state.selectedCourseId = "";
    state.attendance = null;
    state.activeSessionKey = "";
    state.log = [];
    state.restoreSnapshot = null;
    state.restoring = false;
    try { await send("BAP_CLEAR_UI_STATE"); } catch (_) {}
    renderApp();
  }

  function renderLogin() {
    const body = document.getElementById("bap-body");
    if (!body) return;
    body.innerHTML = `
      <div class="bap-login-wrap">
        <div class="bap-login-card">
          <div class="bap-login-brand">
            <div class="bap-login-monogram">MP</div>
            <div>
              <span class="bap-eyebrow">SECURE PORTAL ACCESS</span>
              <h2>Sign in to continue</h2>
              <p>Use the same teacher account as your Course/Marks Portal.</p>
            </div>
          </div>

          <form id="bap-login-form" class="bap-login-form">
            <label><span>Username</span><input id="bap-username" type="text" autocomplete="username" placeholder="Teacher username" /></label>
            <label><span>Password</span><input id="bap-password" type="password" autocomplete="current-password" placeholder="Password" /></label>
            <div id="bap-login-error" class="bap-error"></div>
            <button id="bap-login-btn" class="bap-btn primary bap-login-submit" type="submit">Sign in to Marks Portal</button>
          </form>

          <div class="bap-login-security">
            <span class="bap-security-dot"></span>
            <div><strong>Teacher-controlled workflow</strong><small>The assistant can fill Annex attendance, but it never submits it automatically.</small></div>
          </div>
        </div>
      </div>`;
    document.getElementById("bap-login-form")?.addEventListener("submit", handleLogin);
  }

  function renderTeacherApp() {
    const body = document.getElementById("bap-body");
    if (!body) return;
    const profileName = state.profile?.name || state.profile?.username || "Course Teacher";
    const profileMeta = [state.profile?.shortCode, state.profile?.designation].filter(Boolean).join(" · ");
    const initial = esc((profileName || "T").charAt(0).toUpperCase());

    body.innerHTML = `
      <div class="bap-scroll">
        <section class="bap-account-strip">
          <div class="bap-account-left">
            <div class="bap-account-avatar">${initial}</div>
            <div class="bap-account-copy">
              <span>Teacher account</span>
              <strong>${esc(profileName)}</strong>
              <small>${esc(profileMeta || "Marks Portal")}</small>
            </div>
          </div>
          <button id="bap-logout" class="bap-icon-text-btn" type="button">Logout</button>
        </section>

        <section class="bap-workflow-card compact">
          <div class="bap-step-label"><span>01</span><div><strong>Annex form</strong><small>Verify that New Attendance is open</small></div></div>
          <div class="bap-form-buttons">
            <button id="bap-rescan" class="bap-icon-text-btn" type="button">Rescan</button>
            <button id="bap-refresh-annex" class="bap-icon-text-btn bap-refresh-top" type="button" title="Reload Annex, keep the open assistant and course selection">↻ Refresh</button>
          </div>
          <div id="bap-form-state" class="bap-inline-state">Scanning…</div>
        </section>

        <section class="bap-workflow-card">
          <div class="bap-section-heading">
            <div class="bap-step-label"><span>02</span><div><strong>Attendance source</strong><small>Choose the Marks Portal course to read from</small></div></div>
          </div>

          <div class="bap-fields bap-fields-2">
            <label class="bap-field">
              <span>Intake</span>
              <div class="bap-select-shell"><select id="bap-intake-filter"><option value="">Select intake</option></select><b>⌄</b></div>
            </label>
            <label class="bap-field">
              <span>Section</span>
              <div class="bap-select-shell"><select id="bap-section-filter"><option value="">Select section</option></select><b>⌄</b></div>
            </label>
          </div>
          <div class="bap-fields">
            <label class="bap-field">
              <span>Course</span>
              <div class="bap-select-shell"><select id="bap-course-filter"><option value="">Select course</option></select><b>⌄</b></div>
            </label>
          </div>
          <div id="bap-attendance-meta" class="bap-grid" style="display:none"></div>
        </section>

        <section class="bap-workflow-card attendance-card">
          <div class="bap-section-heading attendance-heading">
            <div class="bap-step-label"><span>03</span><div><strong>Saved attendance</strong><small>Select a session and fill it into Annex</small></div></div>
            <button id="bap-next" class="bap-btn primary bap-next" type="button">Fill next <span>→</span></button>
          </div>

          <div class="bap-filter-bar">
            <div class="bap-filter-copy"><strong>Date range</strong><span>Blank means all sessions</span></div>
            <div class="bap-filter-inputs">
              <label><span>From</span><input id="bap-date-from" type="date" /></label>
              <label><span>To</span><input id="bap-date-to" type="date" /></label>
            </div>
          </div>

          <div id="bap-status" class="bap-state">Loading your courses…</div>
          <div id="bap-attendance-list" class="bap-attendance-list"></div>

          <div class="bap-refresh-options">
            <label class="bap-refresh-toggle" for="bap-auto-refresh">
              <span class="bap-refresh-copy"><strong>Ready for the next date</strong><small>Refresh Annex after a confirmed successful manual submission. Keep your course and open drawer.</small></span>
              <input id="bap-auto-refresh" type="checkbox" checked aria-label="Auto-refresh Annex after successful submit" />
            </label>
          </div>
          <div class="bap-manual-note">
            <span class="bap-manual-icon">✓</span>
            <div><strong>Manual submit stays enabled</strong><small>Check Annex attendance and click its Submit button yourself. Never auto-submitted.</small></div>
          </div>

          <details class="bap-debug">
            <summary>Activity log</summary>
            <div id="bap-log" class="bap-log"></div>
          </details>
        </section>
      </div>`;

    document.getElementById("bap-logout")?.addEventListener("click", logout);
    document.getElementById("bap-rescan")?.addEventListener("click", renderFormState);
    document.getElementById("bap-next")?.addEventListener("click", fillNextAttendance);
    document.getElementById("bap-refresh-annex")?.addEventListener("click", () => refreshAnnex());
    document.getElementById("bap-auto-refresh")?.addEventListener("change", (event) => {
      state.autoRefreshAfterSubmit = Boolean(event.target.checked);
      scheduleSaveUiState();
    });
    const scroller = document.querySelector("#bap-body .bap-scroll");
    scroller?.addEventListener("scroll", () => {
      if (state.restoring) return;
      state.scrollTop = scroller.scrollTop;
      scheduleSaveUiState();
    }, { passive: true });

    const intake = document.getElementById("bap-intake-filter");
    const section = document.getElementById("bap-section-filter");
    const course = document.getElementById("bap-course-filter");

    intake?.addEventListener("change", () => {
      if (section) section.value = "";
      if (course) course.value = "";
      state.selectedCourseId = "";
      state.attendance = null;
      refreshCourseFilters();
      renderAttendanceSummary();
      renderAttendanceList();
      scheduleSaveUiState();
    });

    section?.addEventListener("change", () => {
      if (course) course.value = "";
      state.selectedCourseId = "";
      state.attendance = null;
      refreshCourseFilters();
      renderAttendanceSummary();
      renderAttendanceList();
      scheduleSaveUiState();
    });

    course?.addEventListener("change", () => loadAttendance(course.value));
    document.getElementById("bap-date-from")?.addEventListener("change", () => { renderAttendanceList(); scheduleSaveUiState(); });
    document.getElementById("bap-date-to")?.addEventListener("change", () => { renderAttendanceList(); scheduleSaveUiState(); });

    refreshCourseFilters();
    restoreAppFields();
    renderFormState();
    renderAttendanceSummary();
    renderAttendanceList();
    renderLog();
  }

  function renderApp() {
    if (!state.authChecked) {
      const body = document.getElementById("bap-body");
      if (body) body.innerHTML = '<div class="bap-checking"><span class="bap-spinner"></span>Checking Marks Portal session…</div>';
      return;
    }
    if (!state.profile) renderLogin();
    else renderTeacherApp();
  }

  async function checkSession() {
    try {
      const session = await send("BAP_GET_SESSION");
      state.profile = session?.loggedIn ? session.profile : null;
    } catch (_) {
      state.profile = null;
    } finally {
      state.authChecked = true;
      renderApp();
      if (state.profile) await loadCourses();
    }
  }

  function injectUi() {
    if (document.getElementById("bap-panel")) return;

    const launcher = document.createElement("button");
    launcher.id = "bap-launcher";
    launcher.type = "button";
    launcher.innerHTML = '<span class="bap-launcher-mark">A</span><span class="bap-launcher-copy"><strong>Attendance Assistant</strong><small>Marks Portal sync</small></span><span class="bap-launcher-arrow">↗</span>';
    launcher.addEventListener("click", () => togglePanel(true));
    document.documentElement.appendChild(launcher);

    const panel = document.createElement("aside");
    panel.id = "bap-panel";
    panel.className = state.panelOpen ? "" : "bap-hidden";
    panel.innerHTML = `
      <header class="bap-head">
        <div class="bap-head-main">
          <div class="bap-brand-mark">BA</div>
          <div class="bap-head-copy">
            <div class="bap-kicker">BUBT · MARKS PORTAL</div>
            <div class="bap-title">Annex Attendance</div>
            <p class="bap-sub">Fetch from Marks Portal. Fill Annex. Submit manually.</p>
          </div>
        </div>
        <div class="bap-head-actions">
          <span class="bap-connection"><i></i>Connected</span>
          <button class="bap-close" id="bap-close" type="button" aria-label="Close">×</button>
        </div>
      </header>
      <div id="bap-body" class="bap-body"></div>`;
    document.documentElement.appendChild(panel);

    panel.querySelector("#bap-close")?.addEventListener("click", () => togglePanel(false));
    renderApp();
    checkSession();
  }

  function togglePanel(open) {
    const panel = document.getElementById("bap-panel");
    if (!panel) return;
    state.panelOpen = open ?? panel.classList.contains("bap-hidden");
    panel.classList.toggle("bap-hidden", !state.panelOpen);
    if (state.panelOpen && state.profile) renderFormState();
    scheduleSaveUiState();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "BAP_TOGGLE_PANEL") togglePanel();
  });

  async function initialize() {
    await restoreUiState();
    injectUi();
    installAnnexSubmitMonitor();
  }

  initialize();
})();
