(() => {
  "use strict";

  const STORAGE_KEY = "qrAttendance.data.v1";
  const ADMIN_SESSION_KEY = "qrAttendance.adminUntil";
  const ADMIN_PIN_KEY = "qrAttendance.adminPin.v1";
  const OLD_SITE_ORIGIN = "https://qr-attendance-local-20261109.workspace-039582.chatgpt.site";
  const NEW_SITE_ORIGIN = "https://shchoi880-source.github.io";
  const SITE_URL = `${NEW_SITE_ORIGIN}/qr-attendance/`;
  const SITE_LABEL = "shchoi880-source.github.io/qr-attendance";
  const IS_OLD_SITE = location.origin === OLD_SITE_ORIGIN;
  const MIGRATE_HASH = "#migrate";
  const ADMIN_DURATION = 30 * 60 * 1000;
  const ATTENDANCE_COOLDOWN = 30 * 60 * 1000;
  const PROTECTED_ROUTES = new Set(["home", "people", "records", "settings"]);
  const VERSION = 1;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const defaultPresets = () => Array.from({ length: 5 }, () => ({ start: "", end: "" }));
  const normalizePresets = (presets) => defaultPresets().map((fallback, index) => {
    const item = Array.isArray(presets) ? presets[index] : null;
    return item && typeof item.start === "string" && typeof item.end === "string" ? { start: item.start, end: item.end } : fallback;
  });
  const normalizeSettings = (settings) => ({ cooldownEnabled: settings?.cooldownEnabled !== false });
  const emptyState = () => ({ version: VERSION, participants: [], records: [], presets: defaultPresets(), settings: normalizeSettings() });
  let data = loadData();
  let currentQrPerson = null;
  let editingPersonId = null;
  let currentSiteQrCardBlob = null;
  let currentSiteQrPreviewUrl = "";
  let qrScanner = null;
  let scanning = false;
  let lastDecodedText = "";
  let lastDecodedAt = 0;
  let scanOverlayTimer = null;
  let deferredInstallPrompt = null;
  let confirmResolver = null;
  let pendingAdminRoute = "home";

  function normalizeRecords(records) {
    return records.map((record) => record && typeof record.time === "string" && record.time.startsWith("24:") ? { ...record, time: "00:" + record.time.slice(3) } : record);
  }

  function loadData() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.participants) && Array.isArray(saved.records)) return { version: VERSION, participants: saved.participants, records: normalizeRecords(saved.records), presets: normalizePresets(saved.presets), settings: normalizeSettings(saved.settings) };
    } catch (error) {
      console.warn("저장 데이터를 읽지 못했습니다.", error);
    }
    return emptyState();
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      showToast("저장 공간이 부족합니다. 백업 후 오래된 기록을 정리해 주세요.");
      console.error(error);
    }
  }

  function localDate(value = new Date()) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function localTime(value = new Date()) {
    const hh = String(value.getHours()).padStart(2, "0");
    const mm = String(value.getMinutes()).padStart(2, "0");
    const ss = String(value.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function displayDate(dateString, includeWeekday = false) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Intl.DateTimeFormat("ko-KR", includeWeekday ? { year: "numeric", month: "long", day: "numeric", weekday: "short" } : { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(year, month - 1, day));
  }

  function formatClockInput(value) {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 4);
    return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
  }

  function isValidClock(value, allowEndOfDay = false) {
    if (allowEndOfDay && value === "24:00") return true;
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function prepareClockInput(input) {
    if (!input || input.dataset.clockReady) return;
    input.dataset.clockReady = "true";
    input.addEventListener("input", () => { input.value = formatClockInput(input.value); });
    input.addEventListener("focus", () => input.select());
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function makeId(prefix = "P") {
    const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().slice(0, 5);
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${random}`;
  }

  function bytesToBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlToText(encoded) {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function qrPayload(person) {
    return `QRA1.${bytesToBase64Url(JSON.stringify({ v: 1, id: person.id, name: person.name }))}`;
  }

  function parseQrPayload(text) {
    try {
      if (text.startsWith("QRA1.")) {
        const parsed = JSON.parse(base64UrlToText(text.slice(5)));
        if (parsed.v === 1 && typeof parsed.id === "string" && typeof parsed.name === "string" && parsed.id && parsed.name.trim()) return { id: parsed.id, name: parsed.name.trim() };
      }
      if (text.startsWith("ATTEND|")) {
        const [, id, ...nameParts] = text.split("|");
        const name = nameParts.join("|").trim();
        if (id && name) return { id, name };
      }
    } catch (error) {
      console.warn("QR 해석 실패", error);
    }
    return null;
  }

  function personById(id) { return data.participants.find((person) => person.id === id); }
  function todayRecords() { const today = localDate(); return data.records.filter((record) => record.date === today); }

  function renderAll() {
    renderHome();
    renderPeople();
    renderRecords();
    renderPresetButtons();
    updateAdminUi();
    updateCooldownUi();
  }

  function renderHome() {
    const today = localDate();
    const records = data.records.filter((record) => record.date === today).sort((a, b) => b.timestamp - a.timestamp);
    const present = new Set(records.map((record) => record.participantId)).size;
    const attendanceCount = records.length;
    const total = data.participants.length;
    const remaining = Math.max(total - present, 0);
    $("#todayPill").textContent = displayDate(today, true);
    $("#heroDate").textContent = displayDate(today, true);
    $("#todayCount").textContent = attendanceCount;
    $("#scanTodayCount").textContent = attendanceCount;
    $("#totalPeopleCount").textContent = `출석 인원 ${present}명`;
    $("#remainingCount").textContent = `미출석 ${remaining}명`;
    $("#todayProgress").style.width = total ? `${Math.min(100, present / total * 100)}%` : "0%";
    const recent = records.slice(0, 5);
    const list = $("#recentList");
    if (!recent.length) {
      list.className = "recent-list empty-state compact";
      list.innerHTML = '<span class="empty-icon">○</span><p>아직 오늘 출석 기록이 없습니다.</p>';
      return;
    }
    list.className = "recent-list";
    list.innerHTML = recent.map((record) => `<div class="recent-item"><span class="avatar">${escapeHtml(record.name.slice(0, 1))}</span><div><strong>${escapeHtml(record.name)}</strong><small>${record.source === "manual" ? "직접 출석" : "QR 출석"}</small></div><time>${escapeHtml(record.time.slice(0, 5))}</time></div>`).join("");
  }

  function renderPeople() {
    const query = $("#peopleSearch").value.trim().toLowerCase();
    const people = data.participants.filter((person) => `${person.name} ${person.phone || ""} ${person.memo || ""}`.toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name, "ko"));
    $("#peopleCountChip").textContent = `${data.participants.length}명 등록`;
    const container = $("#peopleList");
    if (!people.length) {
      container.innerHTML = `<div class="empty-people"><div><span class="empty-icon">♙</span><h2>${query ? "검색 결과가 없습니다" : "아직 등록된 사람이 없습니다"}</h2><p>${query ? "다른 검색어를 입력해 보세요." : "이름을 등록하고 개인 고정 QR을 만들어 보세요."}</p>${query ? "" : '<button class="btn btn-primary" data-open-person>첫 사람 등록하기</button>'}</div></div>`;
      return;
    }
    const today = localDate();
    const todayByPerson = new Map();
    data.records.filter((record) => record.date === today).forEach((record) => todayByPerson.set(record.participantId, (todayByPerson.get(record.participantId) || 0) + 1));
    container.innerHTML = people.map((person) => {
      const details = [person.phone, person.birth, person.memo].filter(Boolean).join(" · ") || "추가 정보 없음";
      const count = todayByPerson.get(person.id) || 0;
      const info = count ? `${details} · 오늘 ${count}회 출석` : details;
      return `<article class="person-card"><span class="avatar">${escapeHtml(person.name.slice(0, 1))}</span><div class="person-main"><strong>${escapeHtml(person.name)}</strong><p>${escapeHtml(info)}</p></div><div class="person-actions"><button class="btn btn-secondary" data-action="edit" data-id="${escapeHtml(person.id)}">수정</button><button class="btn btn-secondary" data-action="qr" data-id="${escapeHtml(person.id)}">QR 보기</button><button class="btn btn-primary" data-action="manual" data-id="${escapeHtml(person.id)}">직접 출석</button></div><button type="button" class="record-delete person-delete" data-action="delete" data-id="${escapeHtml(person.id)}" aria-label="${escapeHtml(person.name)} 삭제" title="사람 삭제">×</button></article>`;
    }).join("");
  }

  function recordFilters() {
    return {
      startDate: $("#recordStartDate").value || localDate(),
      endDate: $("#recordEndDate").value || localDate(),
      start: $("#recordStartTime").value || "00:00",
      end: $("#recordEndTime").value || "24:00",
      query: $("#recordSearch").value.trim().toLowerCase()
    };
  }

  function filteredRecords(includeName = true) {
    const filters = recordFilters();
    const validTimes = isValidClock(filters.start) && isValidClock(filters.end, true) && filters.start < filters.end;
    if (filters.startDate > filters.endDate || !validTimes) return { records: [], filters, valid: false };
    const records = data.records.filter((record) => {
      const time = String(record.time || "00:00").slice(0, 5).replace(/^24:/, "00:");
      const nameMatch = !includeName || !filters.query || record.name.toLowerCase().includes(filters.query);
      return record.date >= filters.startDate && record.date <= filters.endDate && time >= filters.start && time <= filters.end && nameMatch;
    }).sort((a, b) => b.timestamp - a.timestamp);
    return { records, filters, valid: true };
  }

  function renderRecords() {
    const result = filteredRecords(true);
    const records = result.records;
    const participantCount = new Set(records.map((record) => record.participantId)).size;
    $("#recordPresent").textContent = records.length;
    $("#recordAbsent").textContent = participantCount;
    const groups = new Map();
    if (result.valid) {
      data.participants
        .filter((person) => !result.filters.query || person.name.toLowerCase().includes(result.filters.query))
        .forEach((person) => groups.set(person.id, { key: person.id, name: person.name, phone: person.phone || "", records: [] }));
    }
    records.forEach((record) => {
      const key = record.participantId || `name:${record.name}`;
      if (!groups.has(key)) {
        const person = personById(record.participantId);
        groups.set(key, { key, name: person?.name || record.name, phone: person?.phone || "", records: [] });
      }
      groups.get(key).records.push(record);
    });
    const groupedRecords = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const container = $("#recordGroups");
    const empty = $("#recordsEmpty");
    const openGroups = new Set([...container.querySelectorAll("details.record-group[open]")].map((item) => item.dataset.groupKey));
    container.innerHTML = groupedRecords.map((group) => {
      const details = group.records.length ? group.records.map((record, index) => {
        const method = record.source === "manual" ? "직접 출석" : "QR 출석";
        return `<li><span class="record-number">${index + 1}</span><time datetime="${escapeHtml(`${record.date}T${record.time}`)}"><b>${escapeHtml(displayDate(record.date))}</b><span>${escapeHtml(record.time)}</span></time><span class="record-actions"><span class="record-method">${method}</span><button type="button" class="record-delete" data-record-id="${escapeHtml(record.id || "")}" data-record-ts="${escapeHtml(String(record.timestamp || ""))}" data-record-pid="${escapeHtml(record.participantId || "")}" aria-label="이 출석 기록 삭제" title="출석 기록 삭제">×</button></span></li>`;
      }).join("") : '<li class="record-none">조회 기간에 출석 기록이 없습니다.</li>';
      const detailSummary = group.records.length ? `최신순 · 총 ${group.records.length}회` : "조회 기간 내 기록 없음";
      return `<details class="record-group" data-group-key="${escapeHtml(group.key)}"${openGroups.has(group.key) ? " open" : ""}><summary><span class="record-avatar">${escapeHtml(group.name.charAt(0) || "?")}</span><span class="record-person"><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.phone || "연락처 없음")}</small></span><span class="record-total ${group.records.length ? "" : "zero"}"><b>${group.records.length}</b>회 출석</span><span class="record-chevron" aria-hidden="true">⌄</span></summary><div class="record-details"><div class="record-details-head"><strong>상세 출석 내역</strong><span>${detailSummary}</span></div><ol>${details}</ol></div></details>`;
    }).join("");
    $("#recordsEmpty strong").textContent = result.valid ? "조회 조건에 맞는 출석 기록이 없습니다" : "조회 기간과 시간을 확인해 주세요";
    $("#recordsEmpty p").textContent = result.valid ? "기간·시간·이름을 바꾸고 조회 버튼을 눌러보세요." : "시작일·시작시간은 종료일·종료시간보다 앞서야 합니다.";
    empty.classList.toggle("show", groupedRecords.length === 0);
    container.classList.toggle("hidden", groupedRecords.length === 0);
  }

  function renderPresetButtons() {
    $("#presetButtons").innerHTML = normalizePresets(data.presets).map((preset, index) => {
      const configured = preset.start && preset.end;
      return `<button type="button" class="preset-button ${configured ? "configured" : ""}" data-preset-index="${index}" ${configured ? "" : "disabled"}><b>${index + 1}번</b><span>${configured ? `${escapeHtml(preset.start)}~${escapeHtml(preset.end)}` : "미설정"}</span></button>`;
    }).join("");
  }

  function openPresetDialog() {
    const presets = normalizePresets(data.presets);
    $("#presetEditor").innerHTML = presets.map((preset, index) => `<div class="preset-row"><strong>${index + 1}번</strong><label><span>시작</span><input type="text" class="clock-input" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="00:00" aria-label="${index + 1}번 시작 시간 4자리 숫자" data-preset-start="${index}" value="${escapeHtml(preset.start || "00:00")}" /></label><span class="preset-wave">~</span><label><span>종료</span><input type="text" class="clock-input" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="24:00" aria-label="${index + 1}번 종료 시간 4자리 숫자" data-preset-end="${index}" value="${escapeHtml(preset.end || "24:00")}" /></label></div>`).join("");
    $$("#presetEditor .clock-input").forEach(prepareClockInput);
    $("#presetDialog").showModal();
  }

  function savePresets(event) {
    event.preventDefault();
    const presets = defaultPresets().map((_, index) => ({ start: $(`[data-preset-start="${index}"]`).value, end: $(`[data-preset-end="${index}"]`).value }));
    const invalid = presets.find((preset) => (preset.start && !preset.end) || (!preset.start && preset.end) || (preset.start && preset.end && (!isValidClock(preset.start) || !isValidClock(preset.end, true) || preset.start >= preset.end)));
    if (invalid) return showToast("시간을 4자리 숫자로 입력해 주세요. 예: 0900~2400");
    data.presets = presets;
    saveData();
    renderPresetButtons();
    $("#presetDialog").close();
    showToast("시간 프리셋 5개를 저장했습니다.");
  }

  function applyPreset(index) {
    const preset = normalizePresets(data.presets)[index];
    if (!preset?.start || !preset?.end) return;
    $("#recordStartTime").value = preset.start;
    $("#recordEndTime").value = preset.end;
    renderRecords();
    showToast(`${index + 1}번 시간 ${preset.start}~${preset.end}을 적용했습니다.`);
  }

  function navigate(route, updateHistory = true) {
    const valid = ["home", "scan", "people", "records", "settings"];
    if (!valid.includes(route)) route = "scan";
    if (PROTECTED_ROUTES.has(route) && !isAdminUnlocked()) {
      openPinDialog(route);
      return;
    }
    if (route !== "scan" && scanning) stopScanner();
    $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === route));
    $$('[data-route]').forEach((button) => button.classList.toggle("active", button.dataset.route === route));
    if (updateHistory) history.pushState({ route }, "", `#${route}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (route === "records") renderRecords();
    if (route === "people") renderPeople();
  }

  function configuredAdminPin() {
    return localStorage.getItem(ADMIN_PIN_KEY) || "";
  }

  function hasAdminPin() {
    return /^\d{4,8}$/.test(configuredAdminPin());
  }

  function isAdminUnlocked() {
    return !hasAdminPin() || Number(sessionStorage.getItem(ADMIN_SESSION_KEY) || 0) > Date.now();
  }

  function updateAdminUi() {
    const protectedByPin = hasAdminPin();
    const unlocked = isAdminUnlocked();
    const toggle = $("#adminToggle");
    toggle.hidden = !protectedByPin;
    toggle.classList.toggle("unlocked", unlocked);
    toggle.innerHTML = `<span>●</span> ${unlocked ? "관리자 잠금" : "관리자"}`;
    const summary = $("#adminPasswordSummary");
    const button = $("#openAdminPasswordBtn");
    if (summary) summary.textContent = protectedByPin ? "관리자 비밀번호가 설정되어 있습니다. 이 기기에서만 적용됩니다." : "현재 비밀번호 없이 바로 사용할 수 있습니다.";
    if (button) button.textContent = protectedByPin ? "비밀번호 변경·해제" : "비밀번호 설정";
  }

  function openPinDialog(route = "home") {
    if (!hasAdminPin()) {
      navigate(route);
      return;
    }
    pendingAdminRoute = route;
    $("#adminPin").value = "";
    $("#pinError").textContent = "";
    const dialog = $("#pinDialog");
    if (!dialog.open) dialog.showModal();
    setTimeout(() => $("#adminPin").focus(), 50);
  }

  function closePinDialog() {
    $("#pinDialog").close();
    pendingAdminRoute = "home";
  }

  function unlockAdmin(event) {
    event.preventDefault();
    const input = $("#adminPin");
    if (input.value !== configuredAdminPin()) {
      $("#pinError").textContent = "비밀번호가 맞지 않습니다.";
      const content = $(".pin-content");
      content.classList.remove("shake");
      void content.offsetWidth;
      content.classList.add("shake");
      input.select();
      return;
    }
    sessionStorage.setItem(ADMIN_SESSION_KEY, String(Date.now() + ADMIN_DURATION));
    const route = pendingAdminRoute;
    $("#pinDialog").close();
    updateAdminUi();
    showToast("관리자 모드가 30분 동안 열렸습니다.");
    navigate(route);
  }

  function toggleAdmin() {
    if (!hasAdminPin()) {
      navigate("settings");
      return;
    }
    if (isAdminUnlocked()) {
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      updateAdminUi();
      showToast("관리자 모드를 잠갔습니다.");
      navigate("scan");
    } else {
      openPinDialog("home");
    }
  }

  function openAdminPasswordDialog() {
    const enabled = hasAdminPin();
    $("#adminPasswordForm").reset();
    $("#adminPasswordError").textContent = "";
    $("#adminPasswordDialogTitle").textContent = enabled ? "관리자 비밀번호 변경" : "관리자 비밀번호 설정";
    $("#removeAdminPasswordBtn").hidden = !enabled;
    $("#adminPasswordDialog").showModal();
    setTimeout(() => $("#newAdminPassword").focus(), 50);
  }

  function closeAdminPasswordDialog() {
    $("#adminPasswordDialog").close();
  }

  function saveAdminPassword(event) {
    event.preventDefault();
    const password = $("#newAdminPassword").value;
    const confirmation = $("#confirmAdminPassword").value;
    const error = $("#adminPasswordError");
    if (!/^\d{4,8}$/.test(password)) {
      error.textContent = "숫자 4~8자리로 입력해 주세요.";
      return;
    }
    if (password !== confirmation) {
      error.textContent = "두 번 입력한 비밀번호가 다릅니다.";
      return;
    }
    localStorage.setItem(ADMIN_PIN_KEY, password);
    sessionStorage.setItem(ADMIN_SESSION_KEY, String(Date.now() + ADMIN_DURATION));
    closeAdminPasswordDialog();
    updateAdminUi();
    showToast("관리자 비밀번호를 설정했습니다.");
  }

  async function removeAdminPassword() {
    const okay = await askConfirm("관리자 비밀번호를 없앨까요?", "앞으로는 비밀번호 입력 없이 모든 메뉴를 바로 사용할 수 있습니다.", "비밀번호 없애기", false);
    if (!okay) return;
    localStorage.removeItem(ADMIN_PIN_KEY);
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    closeAdminPasswordDialog();
    updateAdminUi();
    showToast("관리자 비밀번호를 없앴습니다.");
  }

  function isCooldownEnabled() {
    return normalizeSettings(data.settings).cooldownEnabled;
  }

  function updateCooldownUi() {
    const enabled = isCooldownEnabled();
    const button = $("#cooldownToggleBtn");
    const summary = $("#cooldownSummary");
    const scanHint = $("#scanCooldownHint");
    if (button) {
      button.textContent = enabled ? "ON" : "OFF";
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("on", enabled);
      button.classList.toggle("off", !enabled);
    }
    if (summary) summary.textContent = enabled ? "같은 사람이 30분 안에 다시 찍으면 출석 횟수에 포함하지 않습니다." : "QR을 찍거나 직접 출석을 누를 때마다 횟수가 계속 올라갑니다.";
    if (scanHint) scanHint.textContent = enabled ? "개인 QR을 네모 안에 보여주세요. 30분이 지나면 다시 출석할 수 있습니다." : "개인 QR을 네모 안에 보여주세요. 횟수 제한 없이 출석할 수 있습니다.";
  }

  function toggleCooldown() {
    data.settings = normalizeSettings(data.settings);
    data.settings.cooldownEnabled = !data.settings.cooldownEnabled;
    saveData();
    updateCooldownUi();
    showToast(data.settings.cooldownEnabled ? "30분 중복 출석 제한을 켰습니다." : "30분 중복 출석 제한을 껐습니다.");
  }

  function openPersonForm(person = null) {
    const editing = person && typeof person.id === "string";
    editingPersonId = editing ? person.id : null;
    $("#personForm").reset();
    $("#personFormEyebrow").textContent = editing ? "회원 정보 수정" : "새 등록";
    $("#personFormTitle").textContent = editing ? `${person.name} 정보 수정` : "사람 정보";
    $("#savePersonBtn").textContent = editing ? "수정 내용 저장" : "저장하고 QR 만들기";
    if (editing) {
      $("#personName").value = person.name || "";
      $("#personBirth").value = person.birth || "";
      $("#personPhone").value = person.phone || "";
      $("#personMemo").value = person.memo || "";
    }
    $("#personFormWrap").classList.remove("hidden");
    $("#openPersonFormBtn").classList.add("hidden");
    setTimeout(() => {
      $("#personFormWrap").scrollIntoView({ behavior: "smooth", block: "start" });
      $("#personName").focus();
    }, 30);
  }

  function closePersonForm() {
    editingPersonId = null;
    $("#personFormWrap").classList.add("hidden");
    $("#openPersonFormBtn").classList.remove("hidden");
    $("#personForm").reset();
  }

  function savePerson(event) {
    event.preventDefault();
    const name = $("#personName").value.trim();
    if (!name) return;
    const values = { name, birth: $("#personBirth").value, phone: $("#personPhone").value.trim(), memo: $("#personMemo").value.trim() };
    if (editingPersonId) {
      const person = personById(editingPersonId);
      if (!person) return closePersonForm();
      Object.assign(person, values, { updatedAt: Date.now() });
      data.records.forEach((record) => { if (record.participantId === person.id) record.name = name; });
      saveData();
      closePersonForm();
      renderAll();
      showToast(`${name}님의 정보를 수정했습니다.`);
      return;
    }
    const person = { id: makeId(), ...values, createdAt: Date.now() };
    data.participants.push(person);
    saveData();
    closePersonForm();
    renderAll();
    openQrDialog(person);
    showToast(`${name}님이 등록되었습니다.`);
  }

  function openQrDialog(person) {
    currentQrPerson = person;
    $("#qrPersonName").textContent = person.name;
    $("#qrPersonId").textContent = person.id;
    const target = $("#qrCode");
    target.innerHTML = "";
    if (typeof QRCode === "undefined") {
      target.innerHTML = "<p>QR 생성 기능을 불러오지 못했습니다.<br>인터넷 연결 후 다시 열어 주세요.</p>";
    } else {
      new QRCode(target, { text: qrPayload(person), width: 276, height: 276, colorDark: "#12372a", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    }
    $("#qrDialog").showModal();
  }

  function qrImageData() {
    const canvas = $("#qrCode canvas");
    const image = $("#qrCode img");
    if (canvas) return canvas.toDataURL("image/png");
    return image?.src || "";
  }

  function drawRoundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function makeQrCardCanvas(qrCanvas, { eyebrow, title, description, footer }) {
    const card = document.createElement("canvas");
    card.width = 900;
    card.height = 1160;
    const context = card.getContext("2d");
    context.fillStyle = "#f3efe4";
    context.fillRect(0, 0, card.width, card.height);
    context.fillStyle = "#fffdf8";
    drawRoundRect(context, 55, 45, 790, 1070, 38);
    context.fill();

    context.textAlign = "center";
    context.fillStyle = "#12372a";
    context.font = "800 24px Arial, sans-serif";
    context.fillText(eyebrow, 450, 112);
    context.font = "800 54px Arial, sans-serif";
    context.fillText(title, 450, 184);
    context.fillStyle = "#65716b";
    context.font = "26px Arial, sans-serif";
    context.fillText(description, 450, 232);

    context.fillStyle = "#ffffff";
    context.strokeStyle = "#d9ddd7";
    context.lineWidth = 3;
    drawRoundRect(context, 115, 275, 670, 670, 30);
    context.fill();
    context.stroke();
    context.drawImage(qrCanvas, 160, 320, 580, 580);

    context.fillStyle = "#12372a";
    context.font = "800 29px Arial, sans-serif";
    context.fillText("카메라로 QR을 비춰주세요", 450, 1000);
    context.fillStyle = "#65716b";
    context.font = "20px Arial, sans-serif";
    context.fillText(footer, 450, 1052, 700);
    return card;
  }

  function canvasBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  async function downloadCurrentQr() {
    if (!currentQrPerson) return;
    const qrCanvas = $("#qrCode canvas");
    if (!qrCanvas) return showToast("QR 이미지가 아직 준비되지 않았습니다.");
    const card = makeQrCardCanvas(qrCanvas, {
      eyebrow: "출석용 개인 고정 QR",
      title: currentQrPerson.name,
      description: "출석할 때 카메라 화면에 보여주세요.",
      footer: currentQrPerson.id
    });
    const blob = await canvasBlob(card);
    if (!blob) return showToast("QR 안내 이미지를 만들지 못했습니다.");
    const action = await shareOrDownloadFile(blob, `QR_${safeFilename(currentQrPerson.name)}_${currentQrPerson.id}.png`, `${currentQrPerson.name} 출석 QR`);
    if (action === "shared-file") showToast("공유창에서 사진·파일 앱을 선택해 저장하세요.");
    if (action === "download-requested") showToast("QR 이미지 저장을 요청했습니다. 다운로드 목록을 확인하세요.");
    if (action === "cancelled") showToast("QR 저장을 취소했습니다.");
  }

  function renderSiteAccessQr() {
    const target = $("#siteAccessQr");
    if (!target) return;
    target.innerHTML = "";
    if (typeof QRCode === "undefined") {
      target.innerHTML = "<p>QR 생성 기능을 불러오지 못했습니다.</p>";
      return;
    }
    new QRCode(target, { text: SITE_URL, width: 720, height: 720, colorDark: "#12372a", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.H });
  }

  async function makeSiteQrCardBlob() {
    const canvas = $("#siteAccessQr canvas");
    if (!canvas) return null;
    const card = makeQrCardCanvas(canvas, {
      eyebrow: "공유용 접속 QR",
      title: "QR 출석부 접속하기",
      description: "휴대폰 기본 카메라로 QR을 비춰주세요.",
      footer: SITE_LABEL
    });
    return canvasBlob(card);
  }

  async function shareSiteAccessQr() {
    currentSiteQrCardBlob = await makeSiteQrCardBlob();
    if (!currentSiteQrCardBlob) return showToast("접속 QR이 아직 준비되지 않았습니다.");
    const preview = $("#siteQrCardPreview");
    if (currentSiteQrPreviewUrl) URL.revokeObjectURL(currentSiteQrPreviewUrl);
    currentSiteQrPreviewUrl = URL.createObjectURL(currentSiteQrCardBlob);
    preview.src = currentSiteQrPreviewUrl;
    $("#siteQrDialog").showModal();
  }

  function closeSiteQrDialog() {
    $("#siteQrDialog").close();
  }

  async function saveSiteAccessQr() {
    currentSiteQrCardBlob ||= await makeSiteQrCardBlob();
    if (!currentSiteQrCardBlob) return showToast("접속 QR 안내 이미지를 만들지 못했습니다.");
    const action = await shareOrDownloadFile(currentSiteQrCardBlob, "QR출석부_사이트_접속_안내.png", "QR 출석부 사이트 접속 QR");
    if (action === "shared-file") showToast("공유창에서 사진·파일 앱을 선택해 저장하세요.");
    if (action === "download-requested") showToast("QR 이미지 저장을 요청했습니다. 안 보이면 이미지를 길게 눌러 저장하세요.");
    if (action === "cancelled") showToast("QR 내보내기를 취소했습니다.");
  }

  async function copySiteUrl() {
    try {
      await navigator.clipboard.writeText(SITE_URL);
      showToast("사이트 주소를 복사했습니다.");
    } catch (_) {
      const input = document.createElement("textarea");
      input.value = SITE_URL;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      showToast("사이트 주소를 복사했습니다.");
    }
  }

  function printCurrentQr() {
    if (!currentQrPerson) return;
    const url = qrImageData();
    if (!url) return showToast("QR 이미지가 아직 준비되지 않았습니다.");
    const popup = window.open("", "_blank", "width=560,height=700");
    if (!popup) return showToast("팝업을 허용한 뒤 다시 시도해 주세요.");
    popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(currentQrPerson.name)} QR</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:50px;color:#12372a}h1{font-size:34px;margin:0 0 8px}.id{color:#69756f;font:13px monospace;margin-bottom:26px}img{width:340px;max-width:90%}p{margin-top:24px;color:#69756f}@media print{body{padding-top:80px}}</style></head><body><h1>${escapeHtml(currentQrPerson.name)}</h1><div class="id">${escapeHtml(currentQrPerson.id)}</div><img src="${url}" alt="QR"><p>출석용 개인 고정 QR</p><script>window.onload=()=>window.print()<\/script></body></html>`);
    popup.document.close();
  }

  async function startScanner() {
    if (scanning) return;
    if (typeof Html5Qrcode === "undefined") return showToast("QR 인식 기능을 불러오지 못했습니다. 인터넷 연결 후 새로고침해 주세요.");
    const startButton = $("#startScanBtn");
    startButton.disabled = true;
    startButton.textContent = "카메라 연결 중…";
    try {
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras.length) throw new Error("사용 가능한 카메라가 없습니다.");
      fillCameraSelect(cameras);
      const selected = $("#cameraSelect").value;
      const preferred = cameras.find((camera) => /back|rear|environment|후면/i.test(camera.label)) || cameras[cameras.length - 1];
      const cameraId = selected || preferred.id;
      const reader = $("#reader");
      reader.innerHTML = "";
      qrScanner = new Html5Qrcode("reader", { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
      await qrScanner.start(cameraId, { fps: 10, qrbox: (width, height) => { const size = Math.floor(Math.min(width, height) * .68); return { width: size, height: size }; }, aspectRatio: 1 }, handleDecoded, () => {});
      scanning = true;
      $("#cameraSelect").value = cameraId;
      $("#cameraSelect").disabled = false;
      startButton.classList.add("hidden");
      $("#stopScanBtn").classList.remove("hidden");
    } catch (error) {
      console.error(error);
      resetReaderPlaceholder("카메라를 열 수 없습니다", "카메라 권한과 다른 앱의 카메라 사용 여부를 확인해 주세요.");
      showToast(error?.message || "카메라를 시작하지 못했습니다.");
    } finally {
      startButton.disabled = false;
      startButton.textContent = "카메라 시작";
    }
  }

  function fillCameraSelect(cameras) {
    const select = $("#cameraSelect");
    const previous = select.value;
    select.innerHTML = cameras.map((camera, index) => `<option value="${escapeHtml(camera.id)}">${escapeHtml(camera.label || `카메라 ${index + 1}`)}</option>`).join("");
    if (cameras.some((camera) => camera.id === previous)) select.value = previous;
  }

  async function stopScanner() {
    clearTimeout(scanOverlayTimer);
    $("#scanResult").className = "scan-result";
    if (qrScanner) {
      try { if (scanning) await qrScanner.stop(); } catch (error) { console.warn(error); }
      try { qrScanner.clear(); } catch (error) { console.warn(error); }
    }
    qrScanner = null;
    scanning = false;
    $("#startScanBtn").classList.remove("hidden");
    $("#stopScanBtn").classList.add("hidden");
    resetReaderPlaceholder();
  }

  function resetReaderPlaceholder(title = "카메라가 꺼져 있습니다", message = "아래 버튼을 눌러 출석을 시작하세요.") {
    $("#reader").innerHTML = `<div id="scannerPlaceholder" class="scanner-placeholder"><div class="qr-outline"><i></i><i></i><i></i><i></i><span>⌗</span></div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>`;
  }

  function handleDecoded(text) {
    const now = Date.now();
    if (text === lastDecodedText && now - lastDecodedAt < 3500) return;
    lastDecodedText = text;
    lastDecodedAt = now;
    const decoded = parseQrPayload(text);
    if (!decoded) return showScanResult("error", "!", "등록용 QR이 아닙니다", "이 앱에서 만든 개인 QR을 보여주세요.");
    let person = personById(decoded.id);
    if (!person) {
      person = { id: decoded.id, name: decoded.name, birth: "", phone: "", memo: "QR 스캔으로 자동 등록", createdAt: Date.now() };
      data.participants.push(person);
    }
    const result = markAttendance(person, "qr");
    if (result.cooldown) showScanResult("duplicate", "↻", person.name, `30분 이내 재출석은 제외됩니다. 약 ${result.remainingMinutes}분 후 다시 출석할 수 있습니다.`);
    else showScanResult("success", "✓", person.name, `${result.record.time.slice(0, 5)} 출석 완료`);
  }

  function markAttendance(person, source = "manual") {
    const now = new Date();
    const latest = isCooldownEnabled() ? data.records.filter((record) => record.participantId === person.id).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0] : null;
    if (latest) {
      const elapsed = now.getTime() - Number(latest.timestamp || 0);
      if (elapsed >= 0 && elapsed < ATTENDANCE_COOLDOWN) return { cooldown: true, record: latest, remainingMinutes: Math.ceil((ATTENDANCE_COOLDOWN - elapsed) / 60000) };
    }
    const date = localDate(now);
    const record = { id: makeId("A"), participantId: person.id, name: person.name, date, time: localTime(now), timestamp: now.getTime(), source };
    data.records.push(record);
    saveData();
    renderAll();
    return { cooldown: false, record };
  }

  function showScanResult(type, icon, name, message) {
    const overlay = $("#scanResult");
    overlay.className = `scan-result show ${type}`;
    overlay.innerHTML = `<span class="result-icon">${icon}</span><strong>${escapeHtml(name)}</strong><p>${escapeHtml(message)}</p>`;
    if (type === "success") { playTone(); navigator.vibrate?.(80); }
    clearTimeout(scanOverlayTimer);
    scanOverlayTimer = setTimeout(() => { overlay.className = "scan-result"; }, type === "error" ? 2200 : 1800);
  }

  function playTone() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine"; oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(.12, context.currentTime); gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .18);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .18);
    } catch (_) { /* 소리를 지원하지 않는 환경 */ }
  }

  function safeFilename(value) { return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "출석"; }

  function textCell(value) {
    return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
  }

  async function exportCsv() {
    const result = filteredRecords(true);
    if (!result.valid) return showToast("시작 시간은 종료 시간보다 빨라야 합니다.");
    const records = [...result.records].sort((a, b) => a.timestamp - b.timestamp);
    if (!records.length) return showToast("현재 조회 조건에 맞는 출석 기록이 없습니다.");
    const rows = [["이름", "고유번호", "생년월일", "전화번호", "출석날짜", "출석시간", "메모"]];
    records.forEach((record) => {
      const person = personById(record.participantId) || {};
      rows.push([record.name, record.participantId, person.birth || "", person.phone || "", record.date, record.time, person.memo || ""]);
    });
    const text = [
      "QR 출석부 조회 결과",
      `조회 기간: ${result.filters.startDate} ${result.filters.start} ~ ${result.filters.endDate} ${result.filters.end}`,
      `총 출석 횟수: ${records.length}회`,
      "",
      ...rows.map((row) => row.map(textCell).join("\t"))
    ].join("\r\n");
    const timeLabel = `${result.filters.start.replace(":", "")}-${result.filters.end.replace(":", "")}`;
    const filename = `출석명단_${result.filters.startDate}-${result.filters.endDate}_${timeLabel}.txt`;
    const action = await shareOrDownloadFile(new Blob(["\ufeff" + text], { type: "text/plain;charset=utf-8" }), filename, "QR 출석부 조회 결과", text);
    if (action === "shared-file") showToast("공유창에서 메모장·파일 앱을 선택해 TXT로 저장하세요.");
    if (action === "shared-text") showToast("공유창에서 메모장 등에 출석 내역을 저장하세요.");
    if (action === "download-requested") showToast("TXT 파일 저장을 요청했습니다. 다운로드 목록을 확인하세요.");
    if (action === "cancelled") showToast("TXT 내보내기를 취소했습니다.");
  }

  function backupData() {
    const payload = { app: "QR 출석부", version: VERSION, exportedAt: new Date().toISOString(), participants: data.participants, records: data.records, presets: normalizePresets(data.presets), settings: normalizeSettings(data.settings) };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `QR출석부_전체백업_${localDate()}.json`);
    showToast("전체 백업 파일을 저장했습니다.");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function shareOrDownloadFile(blob, filename, title, fallbackText = "", tryPlainTextFile = false) {
    const shareFile = async (file) => {
      if (!navigator.share || !navigator.canShare?.({ files: [file] })) return false;
      try {
        await navigator.share({ title, files: [file] });
        return true;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        console.warn("이 형식의 파일 공유가 거절되었습니다.", error);
        return false;
      }
    };

    try {
      const originalFile = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      if (await shareFile(originalFile)) return "shared-file";
      if (tryPlainTextFile && fallbackText) {
        const textFile = new File([fallbackText], filename, { type: "text/plain;charset=utf-8" });
        if (await shareFile(textFile)) return "shared-file";
      }
      if (navigator.share && fallbackText) {
        await navigator.share({ title, text: fallbackText });
        return "shared-text";
      }
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
      console.warn("휴대폰 공유 기능을 사용할 수 없습니다.", error);
    }

    downloadBlob(blob, filename);
    return "download-requested";
  }

  async function restoreData(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.participants) || !Array.isArray(parsed.records)) throw new Error("올바른 QR 출석부 백업 파일이 아닙니다.");
      const okay = await askConfirm("백업 파일을 복원할까요?", "현재 이 기기에 있는 데이터는 백업 파일의 내용으로 바뀝니다.", "복원하기", false);
      if (!okay) return;
      data = { version: VERSION, participants: parsed.participants, records: normalizeRecords(parsed.records), presets: normalizePresets(parsed.presets), settings: normalizeSettings(parsed.settings) };
      saveData(); renderAll(); showToast("백업 데이터를 복원했습니다.");
    } catch (error) {
      showToast(error.message || "백업 파일을 읽지 못했습니다.");
    } finally {
      $("#restoreInput").value = "";
    }
  }

  function askConfirm(title, text, okayLabel = "삭제", danger = true) {
    $("#confirmTitle").textContent = title;
    $("#confirmText").textContent = text;
    const okay = $("#confirmOkay");
    okay.textContent = okayLabel;
    okay.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    $("#confirmDialog").showModal();
    return new Promise((resolve) => { confirmResolver = resolve; });
  }

  function resolveConfirm(result) {
    $("#confirmDialog").close();
    if (confirmResolver) confirmResolver(result);
    confirmResolver = null;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  async function installApp() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      return;
    }
    const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    showToast(isiOS ? "Safari의 공유 버튼에서 ‘홈 화면에 추가’를 선택하세요." : "브라우저 메뉴에서 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 선택하세요.");
  }

  function bindEvents() {
    document.addEventListener("click", async (event) => {
      const go = event.target.closest("[data-go]");
      if (go) navigate(go.dataset.go);
      const route = event.target.closest("[data-route]");
      if (route) navigate(route.dataset.route);
      if (event.target.closest("[data-open-person]")) openPersonForm();
      if (event.target.closest("[data-close-dialog]")) $("#qrDialog").close();
    });
    $("#openPersonFormBtn").addEventListener("click", () => openPersonForm());
    $("#adminToggle").addEventListener("click", toggleAdmin);
    $("#pinForm").addEventListener("submit", unlockAdmin);
    $("#closePinDialog").addEventListener("click", closePinDialog);
    $("#pinDialog").addEventListener("cancel", (event) => { event.preventDefault(); closePinDialog(); });
    $("#openAdminPasswordBtn").addEventListener("click", openAdminPasswordDialog);
    $("#adminPasswordForm").addEventListener("submit", saveAdminPassword);
    $("#closeAdminPasswordDialog").addEventListener("click", closeAdminPasswordDialog);
    $("#cancelAdminPasswordBtn").addEventListener("click", closeAdminPasswordDialog);
    $("#removeAdminPasswordBtn").addEventListener("click", removeAdminPassword);
    $("#adminPasswordDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeAdminPasswordDialog(); });
    $("#closePersonFormBtn").addEventListener("click", closePersonForm);
    $("#cancelPersonBtn").addEventListener("click", closePersonForm);
    $("#personForm").addEventListener("submit", savePerson);
    $("#peopleSearch").addEventListener("input", renderPeople);
    $("#searchRecordsBtn").addEventListener("click", () => {
      if ($("#recordStartDate").value > $("#recordEndDate").value) return showToast("조회 시작일은 종료일보다 앞서야 합니다.");
      const start = $("#recordStartTime").value;
      const end = $("#recordEndTime").value;
      if (!isValidClock(start) || !isValidClock(end, true) || start >= end) return showToast("시간을 4자리 숫자로 입력해 주세요. 예: 0900~2400");
      renderRecords();
    });
    $("#recordSearch").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("#searchRecordsBtn").click(); } });
    $("#presetButtons").addEventListener("click", (event) => { const button = event.target.closest("[data-preset-index]"); if (button) applyPreset(Number(button.dataset.presetIndex)); });
    $("#openPresetDialogBtn").addEventListener("click", openPresetDialog);
    $("#presetForm").addEventListener("submit", savePresets);
    $("#closePresetDialog").addEventListener("click", () => $("#presetDialog").close());
    $("#cancelPresetBtn").addEventListener("click", () => $("#presetDialog").close());
    $("#presetDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#presetDialog").close(); });
    $("#startScanBtn").addEventListener("click", startScanner);
    $("#stopScanBtn").addEventListener("click", stopScanner);
    $("#cameraSelect").addEventListener("change", async () => { if (scanning) { await stopScanner(); startScanner(); } });
    $("#downloadQrBtn").addEventListener("click", downloadCurrentQr);
    $("#printQrBtn").addEventListener("click", printCurrentQr);
    $("#exportCsvBtn").addEventListener("click", exportCsv);
    $("#shareSiteQrBtn").addEventListener("click", shareSiteAccessQr);
    $("#saveSiteQrImageBtn").addEventListener("click", saveSiteAccessQr);
    $("#copySiteUrlBtn").addEventListener("click", copySiteUrl);
    $("#closeSiteQrDialog").addEventListener("click", closeSiteQrDialog);
    $("#siteQrDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeSiteQrDialog(); });
    $("#backupBtn").addEventListener("click", backupData);
    $("#restoreInput").addEventListener("change", (event) => restoreData(event.target.files[0]));
    $("#cooldownToggleBtn").addEventListener("click", toggleCooldown);
    $("#installBtn").addEventListener("click", installApp);
    $("#confirmCancel").addEventListener("click", () => resolveConfirm(false));
    $("#confirmOkay").addEventListener("click", () => resolveConfirm(true));
    $("#confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); resolveConfirm(false); });
    $("#peopleList").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const person = personById(button.dataset.id);
      if (!person) return;
      if (button.dataset.action === "edit") openPersonForm(person);
      if (button.dataset.action === "qr") openQrDialog(person);
      if (button.dataset.action === "manual") {
        const result = markAttendance(person, "manual");
        showToast(result.cooldown ? `${person.name}님은 30분 이내 출석 기록이 있어 카운트하지 않았습니다. 약 ${result.remainingMinutes}분 남았습니다.` : `${person.name}님 출석 횟수를 1회 추가했습니다.`);
      }
      if (button.dataset.action === "delete") {
        const okay = await askConfirm(`${person.name}님을 삭제할까요?`, "삭제하면 복구할 수 없습니다. 사람 정보만 삭제되고 과거 출석 기록은 남습니다.", "확인");
        if (okay) { data.participants = data.participants.filter((item) => item.id !== person.id); saveData(); renderAll(); showToast("사람 정보를 삭제했습니다."); }
      }
    });
    $("#recordGroups").addEventListener("click", async (event) => {
      const button = event.target.closest(".record-delete");
      if (!button) return;
      event.preventDefault();
      const { recordId, recordTs, recordPid } = button.dataset;
      const matches = (record) => recordId ? record.id === recordId : String(record.timestamp) === recordTs && (record.participantId || "") === recordPid;
      const target = data.records.find(matches);
      if (!target) return;
      const okay = await askConfirm("이 출석 기록을 삭제할까요?", `${target.name}님 ${displayDate(target.date)} ${target.time} 출석 기록입니다. 삭제하면 복구할 수 없습니다.`, "확인");
      if (!okay) return;
      const index = data.records.indexOf(target);
      if (index >= 0) data.records.splice(index, 1);
      saveData();
      renderAll();
      showToast("출석 기록을 삭제했습니다.");
    });
    $("#clearDataBtn").addEventListener("click", async () => {
      const okay = await askConfirm("모든 데이터를 삭제할까요?", "등록한 사람과 모든 출석 기록이 이 기기에서 사라집니다. 이 작업은 되돌릴 수 없습니다.", "모두 삭제");
      if (okay) { data = emptyState(); saveData(); renderAll(); showToast("모든 데이터를 삭제했습니다."); }
    });
    window.addEventListener("popstate", () => navigate(location.hash.slice(1) || "scan", false));
    window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; });
  }

  // ---- 주소 이사(옛 ChatGPT 주소 → GitHub Pages) ----
  // 옛 주소: 안내 배너 + [데이터 옮기기] 버튼. 새 주소 창을 열고 postMessage로 데이터를 넘깁니다.
  // 새 주소(#migrate): 옛 주소에서 온 메시지만 받아 기존 데이터와 합칩니다(같은 기록은 중복되지 않음).
  function setupOldSiteMoveBanner() {
    const banner = document.createElement("div");
    banner.className = "move-banner";
    banner.innerHTML = `<div class="move-banner-text"><strong>QR 출석부 주소가 바뀌었습니다</strong><span>아래 버튼을 한 번 누르면 이 기기의 사람 목록과 출석 기록이 새 주소로 옮겨집니다.</span></div><div class="move-banner-actions"><button type="button" class="btn btn-primary" id="moveDataBtn">데이터 옮기고 새 주소로 가기</button><button type="button" class="text-btn" id="moveBackupBtn">백업 파일로 옮기기</button></div>`;
    document.body.prepend(banner);
    document.body.classList.add("has-move-banner");
    let popup = null;
    let sent = false;
    window.addEventListener("message", (event) => {
      if (event.origin !== NEW_SITE_ORIGIN || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "qra-migrate-ready" && popup && event.source === popup && !sent) {
        sent = true;
        popup.postMessage({ type: "qra-migrate-data", payload: { data, adminPin: localStorage.getItem(ADMIN_PIN_KEY) || "" } }, NEW_SITE_ORIGIN);
      }
      if (event.data.type === "qra-migrate-done") {
        $(".move-banner-text span", banner).textContent = `옮기기 완료! 사람 ${event.data.people}명, 출석 ${event.data.records}건이 새 주소에 있습니다. 이제 새 주소를 사용해 주세요.`;
        $("#moveDataBtn").textContent = "새 주소 열기";
        showToast("새 주소로 데이터를 옮겼습니다.");
      }
    });
    $("#moveDataBtn").addEventListener("click", () => {
      sent = false;
      popup = window.open(SITE_URL + MIGRATE_HASH, "_blank");
      if (!popup) {
        showToast("새 창이 차단되었습니다. 팝업을 허용하거나 '백업 파일로 옮기기'를 이용해 주세요.");
        return;
      }
      setTimeout(() => { if (!sent) showToast("새 주소가 응답하지 않습니다. '백업 파일로 옮기기'를 이용해 주세요."); }, 15000);
    });
    $("#moveBackupBtn").addEventListener("click", async () => {
      backupData();
      await askConfirm("백업 파일로 옮기기", `방금 저장한 백업 파일을 새 주소(${SITE_LABEL})의 설정 → '백업 파일 복원'에서 불러오면 됩니다. 새 주소를 열까요?`, "새 주소 열기", false) && window.open(SITE_URL, "_blank");
    });
  }

  function recordKey(record) {
    return record.id || `${record.participantId || record.name}|${record.timestamp}`;
  }

  function mergeMigratedData(payload) {
    const incoming = payload?.data;
    if (!incoming || !Array.isArray(incoming.participants) || !Array.isArray(incoming.records)) return null;
    const hadData = data.participants.length > 0 || data.records.length > 0;
    const peopleIds = new Set(data.participants.map((person) => person.id));
    incoming.participants.forEach((person) => { if (person && person.id && !peopleIds.has(person.id)) { data.participants.push(person); peopleIds.add(person.id); } });
    const recordKeys = new Set(data.records.map(recordKey));
    normalizeRecords(incoming.records).forEach((record) => { if (record && !recordKeys.has(recordKey(record))) { data.records.push(record); recordKeys.add(recordKey(record)); } });
    const presetsEmpty = normalizePresets(data.presets).every((preset) => !preset.start && !preset.end);
    if (presetsEmpty) data.presets = normalizePresets(incoming.presets);
    if (!hadData) data.settings = normalizeSettings(incoming.settings);
    if (payload.adminPin && !hasAdminPin()) localStorage.setItem(ADMIN_PIN_KEY, payload.adminPin);
    saveData();
    renderAll();
    return { people: data.participants.length, records: data.records.length };
  }

  function setupMigrationReceiver() {
    if (IS_OLD_SITE || location.hash !== MIGRATE_HASH) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (!window.opener) return;
    let done = false;
    window.addEventListener("message", (event) => {
      if (done || event.origin !== OLD_SITE_ORIGIN || event.source !== window.opener || event.data?.type !== "qra-migrate-data") return;
      const result = mergeMigratedData(event.data.payload);
      if (!result) { showToast("옮길 데이터를 읽지 못했습니다. 백업 파일로 옮겨 주세요."); return; }
      done = true;
      try { window.opener.postMessage({ type: "qra-migrate-done", ...result }, OLD_SITE_ORIGIN); } catch (error) { console.warn(error); }
      showToast(`기존 데이터를 옮겼습니다. 사람 ${result.people}명, 출석 ${result.records}건`);
    });
    let tries = 0;
    const ping = () => {
      if (done || tries++ > 20 || !window.opener) return;
      try { window.opener.postMessage({ type: "qra-migrate-ready" }, OLD_SITE_ORIGIN); } catch (error) { return; }
      setTimeout(ping, 500);
    };
    ping();
  }

  function initialize() {
    setupMigrationReceiver();
    if (IS_OLD_SITE) setupOldSiteMoveBanner();
    $("#recordStartDate").value = localDate();
    $("#recordEndDate").value = localDate();
    prepareClockInput($("#recordStartTime"));
    prepareClockInput($("#recordEndTime"));
    renderSiteAccessQr();
    bindEvents();
    renderAll();
    navigate(location.hash.slice(1) || "scan", false);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch((error) => console.warn("오프라인 준비 실패", error));
  }

  initialize();
})();
