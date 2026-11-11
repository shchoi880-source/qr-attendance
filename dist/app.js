(() => {
  "use strict";

  const STORAGE_KEY = "qrAttendance.data.v1";
  const ADMIN_SESSION_KEY = "qrAttendance.adminUntil";
  const ADMIN_PIN = "14035";
  const SITE_URL = "https://qr-attendance-local-20261109.workspace-039582.chatgpt.site";
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
  const emptyState = () => ({ version: VERSION, participants: [], records: [], presets: defaultPresets() });
  let data = loadData();
  let currentQrPerson = null;
  let qrScanner = null;
  let scanning = false;
  let lastDecodedText = "";
  let lastDecodedAt = 0;
  let scanOverlayTimer = null;
  let deferredInstallPrompt = null;
  let confirmResolver = null;
  let pendingAdminRoute = "home";

  function loadData() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.participants) && Array.isArray(saved.records)) return { version: VERSION, participants: saved.participants, records: saved.records, presets: normalizePresets(saved.presets) };
    } catch (error) {
      console.warn("저장 데이터를 읽지 못했습니다.", error);
    }
    return emptyState();
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      updateStorageSummary();
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
    return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
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
    updateStorageSummary();
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
      return `<article class="person-card"><span class="avatar">${escapeHtml(person.name.slice(0, 1))}</span><div class="person-main"><strong>${escapeHtml(person.name)}</strong><p>${escapeHtml(info)}</p></div><div class="person-actions"><button class="btn btn-secondary" data-action="qr" data-id="${escapeHtml(person.id)}">QR 보기</button><button class="btn btn-primary" data-action="manual" data-id="${escapeHtml(person.id)}">직접 출석</button><button class="btn btn-secondary more-btn" data-action="delete" data-id="${escapeHtml(person.id)}" aria-label="${escapeHtml(person.name)} 삭제">×</button></div></article>`;
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
      const time = String(record.time || "00:00").slice(0, 5);
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
    container.innerHTML = groupedRecords.map((group) => {
      const details = group.records.length ? group.records.map((record, index) => {
        const method = record.source === "manual" ? "직접 출석" : "QR 출석";
        return `<li><span class="record-number">${index + 1}</span><time datetime="${escapeHtml(`${record.date}T${record.time}`)}"><b>${escapeHtml(displayDate(record.date))}</b><span>${escapeHtml(record.time)}</span></time><span class="record-method">${method}</span></li>`;
      }).join("") : '<li class="record-none">조회 기간에 출석 기록이 없습니다.</li>';
      const detailSummary = group.records.length ? `최신순 · 총 ${group.records.length}회` : "조회 기간 내 기록 없음";
      return `<details class="record-group"><summary><span class="record-avatar">${escapeHtml(group.name.charAt(0) || "?")}</span><span class="record-person"><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.phone || "연락처 없음")}</small></span><span class="record-total ${group.records.length ? "" : "zero"}"><b>${group.records.length}</b>회 출석</span><span class="record-chevron" aria-hidden="true">⌄</span></summary><div class="record-details"><div class="record-details-head"><strong>상세 출석 내역</strong><span>${detailSummary}</span></div><ol>${details}</ol></div></details>`;
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

  function isAdminUnlocked() {
    return Number(sessionStorage.getItem(ADMIN_SESSION_KEY) || 0) > Date.now();
  }

  function updateAdminUi() {
    const unlocked = isAdminUnlocked();
    const toggle = $("#adminToggle");
    toggle.classList.toggle("unlocked", unlocked);
    toggle.innerHTML = `<span>●</span> ${unlocked ? "관리자 잠금" : "관리자"}`;
  }

  function openPinDialog(route = "home") {
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
    if (input.value !== ADMIN_PIN) {
      $("#pinError").textContent = "PIN 번호가 맞지 않습니다.";
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
    if (isAdminUnlocked()) {
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      updateAdminUi();
      showToast("관리자 모드를 잠갔습니다.");
      navigate("scan");
    } else {
      openPinDialog("home");
    }
  }

  function openPersonForm() {
    $("#personFormWrap").classList.remove("hidden");
    $("#openPersonFormBtn").classList.add("hidden");
    setTimeout(() => $("#personName").focus(), 30);
  }

  function closePersonForm() {
    $("#personFormWrap").classList.add("hidden");
    $("#openPersonFormBtn").classList.remove("hidden");
    $("#personForm").reset();
  }

  function addPerson(event) {
    event.preventDefault();
    const name = $("#personName").value.trim();
    if (!name) return;
    const person = { id: makeId(), name, birth: $("#personBirth").value, phone: $("#personPhone").value.trim(), memo: $("#personMemo").value.trim(), createdAt: Date.now() };
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

  function downloadCurrentQr() {
    if (!currentQrPerson) return;
    const url = qrImageData();
    if (!url) return showToast("QR 이미지가 아직 준비되지 않았습니다.");
    const link = document.createElement("a");
    link.href = url;
    link.download = `QR_${safeFilename(currentQrPerson.name)}_${currentQrPerson.id}.png`;
    link.click();
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

  async function shareSiteAccessQr() {
    const canvas = $("#siteAccessQr canvas");
    if (!canvas) return showToast("접속 QR이 아직 준비되지 않았습니다.");
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return showToast("접속 QR 이미지를 만들지 못했습니다.");
    const action = await shareOrDownloadFile(blob, "QR출석부_사이트_접속용_QR.png", "QR 출석부 사이트 접속 QR");
    if (action === "shared") showToast("접속 QR을 공유하거나 저장했습니다.");
    if (action === "downloaded") showToast("접속 QR 이미지를 다운로드했습니다.");
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
    const latest = data.records.filter((record) => record.participantId === person.id).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0];
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

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
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
    const csv = "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const timeLabel = `${result.filters.start.replace(":", "")}-${result.filters.end.replace(":", "")}`;
    const filename = `출석명단_${result.filters.startDate}-${result.filters.endDate}_${timeLabel}.csv`;
    const action = await shareOrDownloadFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename, "QR 출석부 조회 결과");
    if (action === "shared") showToast("CSV 파일을 공유하거나 저장했습니다.");
    if (action === "downloaded") showToast("CSV 파일을 다운로드했습니다.");
  }

  function backupData() {
    const payload = { app: "QR 출석부", version: VERSION, exportedAt: new Date().toISOString(), participants: data.participants, records: data.records, presets: normalizePresets(data.presets) };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `QR출석부_전체백업_${localDate()}.json`);
    showToast("전체 백업 파일을 저장했습니다.");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function shareOrDownloadFile(blob, filename, title) {
    try {
      const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title, files: [file] });
        return "shared";
      }
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
      console.warn("파일 공유를 사용할 수 없어 다운로드로 전환합니다.", error);
    }
    downloadBlob(blob, filename);
    return "downloaded";
  }

  async function restoreData(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.participants) || !Array.isArray(parsed.records)) throw new Error("올바른 QR 출석부 백업 파일이 아닙니다.");
      const okay = await askConfirm("백업 파일을 복원할까요?", "현재 이 기기에 있는 데이터는 백업 파일의 내용으로 바뀝니다.", "복원하기", false);
      if (!okay) return;
      data = { version: VERSION, participants: parsed.participants, records: parsed.records, presets: normalizePresets(parsed.presets) };
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

  async function updateStorageSummary() {
    const target = $("#storageSummary");
    if (!target || !navigator.storage?.estimate) return;
    try {
      const estimate = await navigator.storage.estimate();
      const used = estimate.usage || new Blob([JSON.stringify(data)]).size;
      const persistent = await navigator.storage.persisted?.();
      target.textContent = `현재 약 ${formatBytes(used)} 사용 중 · ${persistent ? "보관 보호됨" : "일반 보관 중"}`;
    } catch (_) { target.textContent = "이 기기의 브라우저 저장소를 사용합니다."; }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  async function requestPersistence() {
    if (!navigator.storage?.persist) return showToast("이 브라우저는 저장소 보호 요청을 지원하지 않습니다.");
    const granted = await navigator.storage.persist();
    showToast(granted ? "데이터 보관 보호가 적용되었습니다." : "보관 보호가 허용되지 않았습니다. 정기적으로 백업해 주세요.");
    updateStorageSummary();
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
    $("#openPersonFormBtn").addEventListener("click", openPersonForm);
    $("#adminToggle").addEventListener("click", toggleAdmin);
    $("#pinForm").addEventListener("submit", unlockAdmin);
    $("#closePinDialog").addEventListener("click", closePinDialog);
    $("#pinDialog").addEventListener("cancel", (event) => { event.preventDefault(); closePinDialog(); });
    $("#closePersonFormBtn").addEventListener("click", closePersonForm);
    $("#cancelPersonBtn").addEventListener("click", closePersonForm);
    $("#personForm").addEventListener("submit", addPerson);
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
    $("#backupBtn").addEventListener("click", backupData);
    $("#restoreInput").addEventListener("change", (event) => restoreData(event.target.files[0]));
    $("#persistBtn").addEventListener("click", requestPersistence);
    $("#installBtn").addEventListener("click", installApp);
    $("#confirmCancel").addEventListener("click", () => resolveConfirm(false));
    $("#confirmOkay").addEventListener("click", () => resolveConfirm(true));
    $("#confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); resolveConfirm(false); });
    $("#peopleList").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const person = personById(button.dataset.id);
      if (!person) return;
      if (button.dataset.action === "qr") openQrDialog(person);
      if (button.dataset.action === "manual") {
        const result = markAttendance(person, "manual");
        showToast(result.cooldown ? `${person.name}님은 30분 이내 출석 기록이 있어 카운트하지 않았습니다. 약 ${result.remainingMinutes}분 남았습니다.` : `${person.name}님 출석 횟수를 1회 추가했습니다.`);
      }
      if (button.dataset.action === "delete") {
        const okay = await askConfirm(`${person.name}님을 삭제할까요?`, "사람 정보는 삭제되지만 과거 출석 기록은 유지됩니다.");
        if (okay) { data.participants = data.participants.filter((item) => item.id !== person.id); saveData(); renderAll(); showToast("사람 정보를 삭제했습니다."); }
      }
    });
    $("#clearDataBtn").addEventListener("click", async () => {
      const okay = await askConfirm("모든 데이터를 삭제할까요?", "등록한 사람과 모든 출석 기록이 이 기기에서 사라집니다. 이 작업은 되돌릴 수 없습니다.", "모두 삭제");
      if (okay) { data = emptyState(); saveData(); renderAll(); showToast("모든 데이터를 삭제했습니다."); }
    });
    window.addEventListener("popstate", () => navigate(location.hash.slice(1) || "scan", false));
    window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; });
  }

  function initialize() {
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
