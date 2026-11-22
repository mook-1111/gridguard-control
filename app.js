const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const META = [
  { id: "ch1", channel: "CH1", name: "重要照明", icon: "◉", priority: "重要負載", priorityClass: "critical" },
  { id: "ch2", channel: "CH2", name: "環境風扇", icon: "✣", priority: "一般負載", priorityClass: "" },
  { id: "ch3", channel: "CH3", name: "一般插座", icon: "⌑", priority: "可卸載負載", priorityClass: "" },
];
const cfg = {
  base: sessionStorage.getItem("gridguard.deviceUrl") || "",
};
const CLOUD_MODE = location.protocol === "https:";
const MQTT_CONFIG = {
  url: "wss://broker.emqx.io:8084/mqtt",
  topicRoot: "gridguard/demo-82f6c19e4d7a5b30",
};
const MQTT_TOPICS = {
  status: `${MQTT_CONFIG.topicRoot}/status`,
  command: `${MQTT_CONFIG.topicRoot}/command`,
  ack: `${MQTT_CONFIG.topicRoot}/ack`,
};
const state = { connected: false, busy: false, error: "尚未連接 ESP32", status: null, updated: null, events: [], history: Array(36).fill(null) };
let pending = null;
let mqttClient = null;
let mqttLoading = null;
let lastMqttMessageAt = 0;
const mqttRequests = new Map();
const refs = Object.fromEntries([
  "clockTime", "clockDate", "controllerStatusText", "controllerAddress", "lastUpdateSide", "connectionBadge",
  "mainBreakerMetric", "mainBreakerChip", "mainBreakerSub", "totalPower", "activeCircuits", "supplySource", "supplyChip", "supplySub",
  "batterySocMetric", "batteryMiniBar", "batteryStateMetric", "gridNode", "gridNodeValue", "breakerNode", "breakerNodeText", "busNode", "busValue", "switchSourceText", "lineGrid", "lineBus",
  "batteryNodeValue", "remoteLockBadge", "breakerVisual", "breakerVisualText", "breakerVisualSub", "masterActionBtn", "restoreMasterBtn", "lastMasterAction", "circuitsGrid",
  "batteryGauge", "batterySoc", "batteryVoltage", "batteryCurrent", "chargingChip", "batteryFlow",
  "peakPower", "avgPower", "powerChart", "eventTableBody", "confirmModal", "modalIcon", "modalKicker", "modalTitle", "modalDescription", "modalImpact",
  "confirmField", "confirmInput", "modalConfirmBtn", "connectionModal", "connectionHelp", "deviceUrlField", "deviceUrlInput", "mixedContentWarning", "toastRegion", "statusDot",
].map((id) => [id, $(`#${id}`)]));

const finite = (v) => v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const unit = (v, u, d = 1, fallback = "—") => v == null ? fallback : `${Number(v).toFixed(d)} ${u}`;
const number = (v, d = 1) => v == null ? "—" : Number(v).toFixed(d);
const esc = (v) => String(v).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);
const api = (path) => `${cfg.base.trim().replace(/\/$/, "")}${path}`;
const headers = (json = false) => json ? { "Content-Type": "application/json" } : {};

async function fetchTimed(url, options = {}, ms = 2800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" }); }
  finally { clearTimeout(timer); }
}

function loadMqttLibrary() {
  if (window.mqtt) return Promise.resolve(window.mqtt);
  if (mqttLoading) return mqttLoading;
  mqttLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/mqtt/dist/mqtt.min.js";
    script.onload = () => resolve(window.mqtt);
    script.onerror = () => reject(new Error("MQTT.js 載入失敗"));
    document.head.append(script);
  });
  return mqttLoading;
}

function applyStatus(data) {
  if (typeof data.main_breaker !== "boolean" || !Array.isArray(data.circuits)) throw new Error("裝置回傳格式不符合 GridGuard API");
  state.status = normalize(data);
  state.connected = true;
  state.error = "";
  state.updated = new Date();
  const p = totalPower();
  state.history.push(p);
  if (state.history.length > 36) state.history.shift();
  render();
}

async function initMqtt() {
  if (mqttClient) return;
  try {
    const mqtt = await loadMqttLibrary();
    mqttClient = mqtt.connect(MQTT_CONFIG.url, {
      clientId: `gridguard-web-${crypto.randomUUID?.() || Math.random().toString(16).slice(2)}`,
      clean: true,
      reconnectPeriod: 2500,
      connectTimeout: 7000,
      keepalive: 30,
    });
    mqttClient.on("connect", () => {
      mqttClient.subscribe([MQTT_TOPICS.status, MQTT_TOPICS.ack], { qos: 0 });
      refs.controllerStatusText.textContent = "雲端已連線，等待 ESP32";
      refs.connectionBadge.textContent = "CLOUD ONLINE";
      refs.connectionBadge.className = "demo-badge online";
    });
    mqttClient.on("message", (topic, payload) => {
      let data;
      try { data = JSON.parse(payload.toString()); }
      catch { return; }
      if (topic === MQTT_TOPICS.status) {
        try { lastMqttMessageAt = Date.now(); applyStatus(data); }
        catch (error) { state.error = friendly(error); }
      } else if (topic === MQTT_TOPICS.ack && data.request_id) {
        const request = mqttRequests.get(data.request_id);
        if (request) { mqttRequests.delete(data.request_id); clearTimeout(request.timer); request.resolve(data); }
      }
    });
    mqttClient.on("offline", () => markDisconnected("MQTT 雲端連線中斷"));
    mqttClient.on("error", () => markDisconnected("MQTT 雲端連線失敗"));
  } catch (error) {
    markDisconnected(friendly(error));
  }
}

function markDisconnected(message = "尚未收到 ESP32 雲端資料") {
  if (!state.connected && state.error === message) return;
  state.connected = false;
  state.error = message;
  render();
}

function normalize(data) {
  const rawSource = String(data.power_source || data.source || "isolated");
  return {
    deviceId: String(data.device_id || "gridguard-esp32"), firmware: String(data.firmware || "未知"), rssi: finite(data.wifi_rssi),
    main: Boolean(data.main_relay_closed ?? data.main_breaker), mainFeedback: Boolean(data.main_feedback_verified), source: ["grid", "battery"].includes(rawSource) ? rawSource : "isolated",
    grid: Boolean(data.main_power_present ?? data.grid_available), gridVoltage: finite(data.main_voltage ?? data.grid_voltage), busVoltage: finite(data.bus_voltage), totalPower: finite(data.total_power),
    battery: { soc: finite(data.battery?.soc), voltage: finite(data.battery?.voltage), current: finite(data.battery?.current), temperature: finite(data.battery?.temperature), backup: finite(data.battery?.backup_minutes) },
    solarW: finite(data.solar_w), solarWh: finite(data.solar_today_wh), faults: Array.isArray(data.faults) ? data.faults : [], events: Array.isArray(data.events) ? data.events : [],
    circuits: META.map((m) => { const x = data.circuits.find((c) => c.id === m.id) || {}; return { ...m, on: Boolean(x.on), fault: Boolean(x.fault), voltage: finite(x.voltage), current: finite(x.current), power: finite(x.power), feedback: Boolean(x.feedback_verified) }; }),
  };
}

function friendly(error) {
  if (error?.name === "AbortError") return "ESP32 連線逾時";
  if (location.protocol === "https:" && cfg.base.startsWith("http://")) return "HTTPS 頁面無法直接連接 HTTP 裝置；請開啟 ESP32 本機頁面";
  if (String(error?.message).includes("Failed to fetch")) return "無法連接 ESP32；請確認 Wi‑Fi、裝置網址與瀏覽器限制";
  return String(error?.message || "ESP32 連線失敗");
}

async function connect(silent = false) {
  if (CLOUD_MODE) {
    await initMqtt();
    return;
  }
  if (state.busy) return;
  state.busy = true;
  if (!silent) { refs.connectionBadge.textContent = "CONNECTING"; refs.controllerStatusText.textContent = "正在連接 ESP32"; }
  try {
    const response = await fetchTimed(api("/api/status"), { headers: headers() });
    if (!response.ok) throw new Error(`ESP32 回應 HTTP ${response.status}`);
    const data = await response.json();
    applyStatus(data);
  } catch (error) {
    state.connected = false; state.error = friendly(error); if (!silent) toast(state.error, "danger");
  } finally { state.busy = false; render(); }
}

function totalPower() {
  if (!state.status) return null;
  if (state.status.totalPower != null) return state.status.totalPower;
  const values = state.status.circuits.map((c) => c.power).filter((v) => v != null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

function busPowered(status = state.status) {
  return Boolean(status && ["grid", "battery"].includes(status.source));
}

function render() { renderConnection(); renderSummary(); renderFlow(); renderMaster(); renderCircuits(); renderEnergy(); renderEvents(); drawChart(); }

function renderConnection() {
  const label = CLOUD_MODE ? "MQTT · broker.emqx.io" : cfg.base ? `ESP32 · ${cfg.base.replace(/^https?:\/\//, "")}` : `ESP32 · ${location.host || "同源裝置"}`;
  refs.controllerAddress.textContent = label;
  refs.connectionBadge.textContent = state.connected ? "DEVICE ONLINE" : "DEVICE OFFLINE";
  refs.connectionBadge.className = `demo-badge ${state.connected ? "online" : "offline"}`;
  refs.controllerStatusText.textContent = state.connected ? "控制器已連線" : CLOUD_MODE && mqttClient?.connected ? "雲端已連線，等待 ESP32" : "等待 ESP32";
  refs.lastUpdateSide.textContent = state.connected ? "剛剛" : "無資料";
  refs.statusDot.className = `status-dot ${state.connected ? "online" : "offline"}`;
}

function renderSummary() {
  if (!state.connected) {
    refs.mainBreakerMetric.textContent = "—"; refs.mainBreakerChip.textContent = "OFFLINE"; refs.mainBreakerChip.className = "state-chip off"; refs.mainBreakerSub.textContent = "等待 ESP32 狀態回報";
    refs.totalPower.textContent = "—"; refs.activeCircuits.textContent = "—"; refs.supplySource.textContent = "—"; refs.supplyChip.textContent = "OFFLINE"; refs.supplyChip.className = "state-chip off"; refs.supplySub.textContent = "尚未取得供電來源";
    refs.batterySocMetric.textContent = "—"; refs.batteryMiniBar.style.width = "0%"; refs.batteryStateMetric.textContent = "等待電池感測資料"; return;
  }
  const s = state.status; const fault = s.faults.length || s.circuits.some((c) => c.fault);
  refs.mainBreakerMetric.textContent = s.main ? "已接通" : "已切斷"; refs.mainBreakerChip.textContent = s.main ? "MAIN ON" : "MAIN OFF"; refs.mainBreakerChip.className = `state-chip ${s.main ? "on" : "off"}`;
  refs.mainBreakerSub.textContent = s.mainFeedback ? "實體接點回授已確認" : s.main && !s.grid ? "繼電器已接通，但未偵測到主電源" : "主電源命令狀態（未配置接點回授）";
  refs.totalPower.textContent = number(totalPower()); refs.activeCircuits.textContent = s.circuits.filter((c) => c.on).length;
  const source = s.source === "grid" ? ["市電供電", "GRID", "grid", "主電源開關開啟，系統使用主電源輸入"] : s.source === "battery" ? ["電池供電", "BATTERY", "battery", "未偵測到主電源，已切換至 1S3P 電池"] : ["無供電", "ISOLATED", "danger", "自動切換模組目前沒有輸出"];
  refs.supplySource.textContent = source[0]; refs.supplyChip.textContent = source[1]; refs.supplyChip.className = `state-chip ${source[2]}`; refs.supplySub.textContent = source[3];
  refs.batterySocMetric.textContent = s.battery.soc == null ? "—" : Math.round(s.battery.soc); refs.batteryMiniBar.style.width = `${s.battery.soc || 0}%`; refs.batteryStateMetric.textContent = s.battery.soc == null ? "SOC 尚未校正" : s.battery.soc < 20 ? "低電量警告" : s.source === "battery" ? "放電供電中" : "電池待機";
}

function renderFlow() {
  const s = state.status; const live = state.connected && s; const energized = Boolean(live && busPowered(s));
  const usingGrid = Boolean(live && s.source === "grid" && s.main && s.grid);
  const usingBattery = Boolean(live && s.source === "battery");
  refs.gridNode.classList.toggle("inactive", !live || !s.grid); refs.gridNodeValue.textContent = !live ? "等待偵測" : s.grid ? (s.gridVoltage == null ? "已偵測" : unit(s.gridVoltage, "V", 2)) : "未偵測";
  refs.breakerNode.classList.toggle("active", Boolean(live && s.main)); refs.breakerNode.classList.toggle("inactive", !live || !s.main); refs.breakerNodeText.textContent = live ? (s.main ? "開啟" : "關閉") : "等待狀態";
  refs.busNode.classList.toggle("active", energized); refs.busNode.classList.toggle("inactive", !energized); refs.busNode.classList.toggle("battery-source", usingBattery); refs.switchSourceText.textContent = !live ? "等待偵測" : usingGrid ? "主電源供電" : usingBattery ? "電池供電" : "無輸出"; refs.busValue.textContent = live ? unit(s.busVoltage, "V", 2) : "—";
  refs.lineGrid.classList.toggle("active", usingGrid); refs.lineBus.classList.toggle("active", usingGrid); refs.lineBus.classList.toggle("battery-active", usingBattery); refs.batteryNodeValue.textContent = live ? unit(s.battery.voltage, "V", 2) : "—"; refs.batteryFlow.classList.toggle("active", usingBattery);
}

function renderMaster() {
  const on = Boolean(state.connected && state.status?.main);
  refs.breakerVisual.classList.toggle("on", on); refs.breakerVisual.classList.toggle("off", !on); refs.breakerVisualText.textContent = !state.connected ? "狀態未知" : on ? "主電源已接通" : "主電源已切斷";
  refs.breakerVisualSub.textContent = !state.connected ? "連接裝置後才能控制" : state.status.mainFeedback ? "實體接點回授已確認" : !on && state.status.source === "battery" ? "已切至電池，ESP32 保持在線" : "尚未配置實體接點回授"; refs.remoteLockBadge.textContent = state.connected ? "操作確認" : "離線鎖定";
  refs.masterActionBtn.classList.toggle("hidden", state.connected && !on); refs.restoreMasterBtn.classList.toggle("hidden", !state.connected || on); refs.masterActionBtn.disabled = !state.connected; refs.lastMasterAction.textContent = state.events[0]?.name || "尚無本次工作階段操作";
}

function renderCircuits() {
  const supplyReady = state.connected && busPowered();
  refs.circuitsGrid.innerHTML = META.map((m) => { const c = state.status?.circuits.find((x) => x.id === m.id) || { on: false, fault: false, voltage: null, current: null, power: null }; const live = supplyReady && c.on; const status = !state.connected ? "等待裝置" : c.fault ? "故障隔離" : live ? (state.status.source === "battery" ? "電池供電中" : "主電源供電中") : !supplyReady ? "匯流排無供電" : "分路已關閉"; return `<article class="circuit-card ${live ? "" : "off"} ${c.fault ? "fault" : ""}"><div class="circuit-top"><div class="circuit-name"><span class="circuit-icon">${m.icon}</span><div><small>${m.channel}</small><strong>${m.name}</strong></div></div><span class="priority-badge ${m.priorityClass}">${m.priority}</span></div><div class="circuit-readings"><div class="circuit-reading"><span>電壓</span><strong>${unit(c.voltage, "V", 2)}</strong></div><div class="circuit-reading"><span>電流</span><strong>${unit(c.current, "A", 2)}</strong></div><div class="circuit-reading"><span>功率</span><strong>${unit(c.power, "W", 2)}</strong></div></div><div class="circuit-footer"><span class="circuit-status"><i></i>${status}</span><button class="toggle-button ${c.on && state.connected ? "" : "off"}" type="button" data-toggle-circuit="${m.id}" aria-label="${c.on ? "關閉" : "開啟"}${m.name}" ${!supplyReady || c.fault ? "disabled" : ""}></button></div></article>`; }).join("");
  $$('[data-toggle-circuit]').forEach((button) => button.addEventListener("click", () => requestCircuit(button.dataset.toggleCircuit)));
}

function renderEnergy() {
  const b = state.status?.battery || {}; refs.batteryGauge.style.setProperty("--soc", b.soc || 0); refs.batterySoc.textContent = b.soc == null ? "—" : Math.round(b.soc); refs.batteryVoltage.textContent = unit(b.voltage, "V", 2); refs.batteryCurrent.textContent = !state.connected ? "離線" : state.status.source === "battery" ? "放電供電中" : "待機";
  refs.chargingChip.textContent = !state.connected ? "離線" : state.status.source === "battery" ? "備援放電中" : "電池待機"; refs.chargingChip.className = `state-chip ${!state.connected ? "off" : state.status.source === "battery" ? "battery" : "charging"}`;
}

function renderEvents() {
  const deviceEvents = (state.status?.events || []).map((e) => ({ time: e.time || new Date().toISOString(), name: e.name || "裝置事件", source: e.source || "ESP32", result: e.result || "已記錄", level: e.level || "normal" })); const list = [...state.events, ...deviceEvents].slice(0, 8); if (!list.length) list.push({ time: new Date().toISOString(), name: "尚無操作事件", source: "ESP32", result: state.connected ? "監控中" : "離線", level: state.connected ? "normal" : "warning" });
  refs.eventTableBody.innerHTML = list.map((e) => `<tr><td>${new Date(e.time).toLocaleTimeString("zh-TW", { hour12: false })}</td><td>${esc(e.name)}</td><td>${esc(e.source)}</td><td><span class="event-result ${e.level === "danger" ? "danger" : e.level === "warning" ? "warning" : ""}">${esc(e.result)}</span></td></tr>`).join("");
}

function requestCircuit(id) { const c = state.status?.circuits.find((x) => x.id === id); const m = META.find((x) => x.id === id); if (!state.connected || !c) return; openConfirm({ type: "circuit", target: id, action: c.on ? "open" : "close", kicker: "實體分路控制", title: `${c.on ? "切斷" : "恢復"}${m.name}？`, description: `命令將傳送至 ESP32 的 ${m.channel} 繼電器。`, impacts: [["目標", `${m.channel} · ${m.name}`], ["目前狀態", c.on ? "供電中" : "已關閉"]], phrase: null, safe: !c.on, confirmText: c.on ? "送出分路斷電命令" : "送出分路復電命令" }); }
function requestMain(action) { const open = action === "open"; openConfirm({ type: "main", target: "main", action, kicker: open ? "主電源電閘命令" : "主電源恢復確認", title: open ? "確認切斷主電源？" : "確認恢復主電源？", description: open ? "ESP32 將切斷降壓後的 5V 主電源輸入，電源切換模組應自動改由 1S3P 電池供電。" : "ESP32 將恢復 5V 主電源輸入；切換模組會在主電源可用時切回。", impacts: [["主電源", open ? "切斷 5V 輸入" : "恢復 5V 輸入"], ["供電來源", open ? "自動切換至 1S3P 電池" : "主電源可用時自動切回"], ["ESP32", "維持供電與網路連線"], ["三路負載", "維持各分路原有開關狀態"]], phrase: open ? "確認切斷主電源" : null, safe: !open, confirmText: open ? "送出主電源切斷命令" : "送出主電源恢復命令" }); }

function openConfirm(c) { pending = c; refs.modalKicker.textContent = c.kicker; refs.modalKicker.className = `section-kicker ${c.safe ? "" : "danger-text"}`; refs.modalTitle.textContent = c.title; refs.modalDescription.textContent = c.description; refs.modalIcon.textContent = c.safe ? "✓" : "!"; refs.modalIcon.className = `modal-icon ${c.safe ? "safe" : "danger"}`; refs.modalImpact.innerHTML = c.impacts.map(([a, b]) => `<div class="impact-item"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join(""); refs.confirmField.classList.toggle("hidden", !c.phrase); refs.confirmField.querySelector("span").textContent = c.phrase ? `請輸入「${c.phrase}」以解鎖操作` : "無需輸入確認文字"; refs.confirmInput.value = ""; refs.confirmInput.placeholder = c.phrase || ""; refs.modalConfirmBtn.textContent = c.confirmText; refs.modalConfirmBtn.className = c.safe ? "secondary-button" : "danger-button"; refs.modalConfirmBtn.disabled = Boolean(c.phrase); show(refs.confirmModal); }
const show = (modal) => { modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; };
const hide = (modal) => { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; };

async function execute() {
  if (!pending || !state.connected || (pending.phrase && refs.confirmInput.value.trim() !== pending.phrase)) return;
  refs.modalConfirmBtn.disabled = true; refs.modalConfirmBtn.textContent = "傳送命令中…";
  const path = pending.type === "main" ? "/api/breaker" : "/api/circuit"; const payload = { target: pending.target, action: pending.action, request_id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` };
  try { const result = await sendControl(path, payload); const name = `${payload.target.toUpperCase()} ${payload.action === "open" ? "斷電" : "復電"}`; state.events.unshift({ time: new Date().toISOString(), name, source: CLOUD_MODE ? "Web → MQTT → ESP32" : "Web → ESP32", result: result.feedback_verified ? "接點已確認" : "命令已接受", level: payload.action === "open" ? "warning" : "normal" }); hide(refs.confirmModal); pending = null; toast(result.feedback_verified ? `${name}，實體回授已確認。` : `${name}命令已送出；未配置實體接點回授。`, result.feedback_verified ? "normal" : "warning"); if (!CLOUD_MODE) await connect(true); }
  catch (error) { refs.modalConfirmBtn.disabled = false; refs.modalConfirmBtn.textContent = pending.confirmText; toast(friendly(error), "danger"); }
}

async function sendControl(path, payload) {
  if (!CLOUD_MODE) {
    const response = await fetchTimed(api(path), { method: "POST", headers: headers(true), body: JSON.stringify(payload) }, 4500);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.accepted !== true) throw new Error(result.error || `控制命令失敗（HTTP ${response.status}）`);
    return result;
  }
  if (!mqttClient?.connected) throw new Error("MQTT 尚未連線");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { mqttRequests.delete(payload.request_id); reject(new Error("ESP32 未在時間內回覆命令")); }, 5000);
    mqttRequests.set(payload.request_id, { resolve, reject, timer });
    mqttClient.publish(MQTT_TOPICS.command, JSON.stringify(payload), { qos: 0, retain: false }, (error) => {
      if (!error) return;
      clearTimeout(timer); mqttRequests.delete(payload.request_id); reject(error);
    });
  }).then((result) => {
    if (result.accepted !== true) throw new Error(result.error || "ESP32 拒絕控制命令");
    return result;
  });
}

function openConnection() {
  refs.deviceUrlInput.value = cfg.base;
  refs.connectionHelp.textContent = CLOUD_MODE ? "此公開網站透過 MQTT 雲端中繼連接 ESP32，不需要位於相同 Wi-Fi。" : "此頁面由 ESP32 提供，將直接使用本機 HTTP API。";
  refs.deviceUrlField.classList.toggle("hidden", CLOUD_MODE);
  refs.mixedContentWarning.classList.toggle("hidden", !CLOUD_MODE);
  refs.mixedContentWarning.innerHTML = CLOUD_MODE ? "展示模式使用公開 EMQX Broker。請勿用於真實住宅電箱或敏感資料。" : "";
  $("#connectionSaveBtn").classList.toggle("hidden", CLOUD_MODE);
  show(refs.connectionModal);
}
async function saveConnection() { let url = refs.deviceUrlInput.value.trim().replace(/\/$/, ""); if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`; cfg.base = url; sessionStorage.setItem("gridguard.deviceUrl", cfg.base); hide(refs.connectionModal); await connect(); }

function drawChart() {
  const canvas = refs.powerChart, rect = canvas.getBoundingClientRect(); if (!rect.width) return; const ratio = devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio); const w = rect.width, h = rect.height, pad = { t: 12, r: 8, b: 24, l: 34 }; const values = state.history.filter((v) => v != null), max = Math.max(10, ...values) * 1.15; ctx.clearRect(0, 0, w, h); ctx.font = '9px "Microsoft JhengHei"'; ctx.fillStyle = "#6f8296"; ctx.strokeStyle = "rgba(128,154,181,.12)";
  for (let i = 0; i <= 4; i++) { const y = pad.t + ((h - pad.t - pad.b) / 4) * i; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); ctx.fillText(`${Math.round(max - max / 4 * i)}W`, 2, y + 3); }
  const pts = state.history.map((v, i) => v == null ? null : ({ x: pad.l + i / 35 * (w - pad.l - pad.r), y: pad.t + (h - pad.t - pad.b) - v / max * (h - pad.t - pad.b) })).filter(Boolean); if (pts.length > 1) { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.strokeStyle = "#66e0a3"; ctx.lineWidth = 2; ctx.stroke(); } ctx.fillStyle = "#6f8296"; ctx.fillText("60 秒前", pad.l, h - 5); ctx.fillText("現在", w - 30, h - 5); refs.peakPower.textContent = values.length ? `${Math.max(...values).toFixed(1)} W` : "—"; refs.avgPower.textContent = values.length ? `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)} W` : "—";
}

function toast(message, type = "normal") { const el = document.createElement("div"); el.className = `toast ${type}`; el.innerHTML = `<span>${type === "danger" ? "!" : type === "warning" ? "△" : "✓"}</span><strong>${esc(message)}</strong>`; refs.toastRegion.append(el); setTimeout(() => el.classList.add("out"), 3500); setTimeout(() => el.remove(), 3800); }
function downloadLog() { const rows = [["時間", "事件", "來源", "結果"], ...state.events.map((e) => [new Date(e.time).toLocaleString("zh-TW"), e.name, e.source, e.result])]; const csv = `\uFEFF${rows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\r\n")}`; const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = `gridguard-events-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url); }
function updateClock() { const now = new Date(); refs.clockTime.textContent = now.toLocaleTimeString("zh-TW", { hour12: false }); refs.clockDate.textContent = now.toLocaleDateString("zh-TW", { weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }); if (state.updated && state.connected) { const sec = Math.round((Date.now() - state.updated) / 1000); refs.lastUpdateSide.textContent = sec < 3 ? "剛剛" : `${sec} 秒前`; } }
function closeMobileMenu() { document.body.classList.remove("menu-open"); $("#menuBtn").setAttribute("aria-expanded", "false"); }
function bind() { refs.masterActionBtn.addEventListener("click", () => requestMain("open")); refs.restoreMasterBtn.addEventListener("click", () => requestMain("close")); refs.confirmInput.addEventListener("input", () => refs.modalConfirmBtn.disabled = refs.confirmInput.value.trim() !== pending?.phrase); refs.modalConfirmBtn.addEventListener("click", execute); $("#modalCancelBtn").addEventListener("click", () => hide(refs.confirmModal)); $("#modalCloseBtn").addEventListener("click", () => hide(refs.confirmModal)); [$("#connectionSettingsBtn"), refs.connectionBadge].forEach((b) => b.addEventListener("click", openConnection)); $("#connectionModalClose").addEventListener("click", () => hide(refs.connectionModal)); $("#connectionCancelBtn").addEventListener("click", () => hide(refs.connectionModal)); $("#connectionSaveBtn").addEventListener("click", saveConnection); $("#refreshBtn").addEventListener("click", () => connect()); $("#downloadLogBtn").addEventListener("click", downloadLog); $("#menuBtn").addEventListener("click", () => { const open = document.body.classList.toggle("menu-open"); $("#menuBtn").setAttribute("aria-expanded", String(open)); }); $$(".nav-item").forEach((link) => link.addEventListener("click", () => { $$(".nav-item").forEach((item) => item.classList.toggle("active", item === link)); closeMobileMenu(); })); window.addEventListener("resize", drawChart); window.addEventListener("keydown", (event) => { if (event.key === "Escape") { hide(refs.confirmModal); hide(refs.connectionModal); closeMobileMenu(); } }); }

bind(); updateClock(); render(); setInterval(updateClock, 1000); connect(true); setInterval(() => { if (document.hidden) return; if (CLOUD_MODE) { if (state.connected && Date.now() - lastMqttMessageAt > 7000) markDisconnected("ESP32 雲端回報逾時"); } else connect(true); }, 2000);
