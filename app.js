'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  camera: $('camera'), overlay: $('overlay'), analysisCanvas: $('analysisCanvas'), cameraStage: $('cameraStage'),
  placeholder: $('cameraPlaceholder'), roiHint: $('roiHint'), cameraBadge: $('cameraBadge'), detectBadge: $('detectBadge'),
  cameraBtn: $('cameraBtn'), roiBtn: $('roiBtn'), calibrateBtn: $('calibrateBtn'), detectBtn: $('detectBtn'),
  motionValue: $('motionValue'), motionFill: $('motionFill'), thresholdMarker: $('thresholdMarker'),
  sensitivity: $('sensitivity'), sensitivityValue: $('sensitivityValue'), statusText: $('statusText'),
  elapsedClock: $('elapsedClock'), sessionBtn: $('sessionBtn'), manualDropBtn: $('manualDropBtn'), testLabel: $('testLabel'),
  statCount: $('statCount'), statLatest: $('statLatest'), statAverage: $('statAverage'), statRange: $('statRange'),
  comparison: $('comparison'), intervalChart: $('intervalChart'), chartEmpty: $('chartEmpty'), timeline: $('timeline'), clearBtn: $('clearBtn'),
  csvBtn: $('csvBtn'), jsonBtn: $('jsonBtn'), shareBtn: $('shareBtn'), helpBtn: $('helpBtn'), helpDialog: $('helpDialog')
};

const state = {
  stream: null,
  cameraOn: false,
  selectingRoi: false,
  roi: null,
  dragStart: null,
  detecting: false,
  analysisTimer: null,
  previousFrame: null,
  baselineMean: 0,
  baselineVar: 0.2,
  calibrated: false,
  calibrating: false,
  calibrationSamples: [],
  hotFrames: 0,
  quietFrames: 0,
  motionArmed: true,
  lastAutoEventAt: 0,
  sessionActive: false,
  sessionStartEpoch: null,
  elapsedTimer: null,
  events: [],
  machineStates: { pump1: false, pump2: false, inlet: false },
  wakeLock: null
};

const STORAGE_KEY = 'leakDropTracker.v1';

function setStatus(text, kind = '') {
  els.statusText.textContent = text;
  els.statusText.dataset.kind = kind;
}

function formatDuration(ms, decimals = false) {
  if (!Number.isFinite(ms)) return '—';
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(decimals ? 2 : 1)}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem.toFixed(1)}s`;
}

function formatClock(ms) {
  ms = Math.max(0, ms || 0);
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function eventContext() {
  return {
    ...state.machineStates,
    label: els.testLabel.value.trim()
  };
}

function saveLocal() {
  try {
    const payload = {
      sessionActive: state.sessionActive,
      sessionStartEpoch: state.sessionStartEpoch,
      events: state.events,
      machineStates: state.machineStates,
      testLabel: els.testLabel.value,
      sensitivity: Number(els.sensitivity.value),
      roi: state.roi
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Local saving is unavailable in this browsing mode', err);
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.events = Array.isArray(saved.events) ? saved.events : [];
    state.sessionActive = Boolean(saved.sessionActive);
    state.sessionStartEpoch = saved.sessionStartEpoch || null;
    state.machineStates = { ...state.machineStates, ...(saved.machineStates || {}) };
    els.testLabel.value = saved.testLabel || '';
    if (saved.sensitivity) els.sensitivity.value = saved.sensitivity;
    if (saved.roi) state.roi = saved.roi;
    updateSensitivityUI();
    updateStateButtons();
    updateSessionUI();
    renderAll();
  } catch (err) {
    console.warn('Could not restore saved session', err);
  }
}

async function startCamera() {
  if (state.cameraOn) {
    stopCamera();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Camera access is unavailable here. Open the site in Safari from an HTTPS address.', 'error');
    return;
  }
  try {
    setStatus('Requesting rear camera permission…');
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 }
      }
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    els.camera.srcObject = state.stream;
    await els.camera.play();
    state.cameraOn = true;
    els.camera.style.display = 'block';
    els.placeholder.classList.add('hidden');
    els.cameraBtn.textContent = 'Stop camera';
    els.roiBtn.disabled = false;
    els.cameraBadge.textContent = 'Camera live';
    els.cameraBadge.classList.add('live');
    resizeOverlay();
    if (!state.roi) setStatus('Choose a small area containing only the puddle surface.');
    else setStatus('Saved detection zone restored. Calibrate before detecting.');
    els.calibrateBtn.disabled = !state.roi;
    els.detectBtn.disabled = !state.roi;
    drawOverlay();
  } catch (err) {
    console.error(err);
    const msg = err.name === 'NotAllowedError'
      ? 'Camera permission was denied. In iPhone Settings, allow Safari camera access for this site.'
      : `Could not open the camera: ${err.message || err.name}`;
    setStatus(msg, 'error');
  }
}

function stopCamera() {
  stopDetection();
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  state.cameraOn = false;
  if (state.analysisTimer) { clearInterval(state.analysisTimer); state.analysisTimer = null; }
  state.previousFrame = null;
  els.camera.srcObject = null;
  els.camera.style.display = 'none';
  els.placeholder.classList.remove('hidden');
  els.cameraBtn.textContent = 'Start camera';
  els.roiBtn.disabled = true;
  els.calibrateBtn.disabled = true;
  els.detectBtn.disabled = true;
  els.cameraBadge.textContent = 'Camera off';
  els.cameraBadge.classList.remove('live');
  setStatus('Camera stopped. Session data remains saved on this device.');
}

function resizeOverlay() {
  const rect = els.cameraStage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  els.overlay.width = Math.round(rect.width * dpr);
  els.overlay.height = Math.round(rect.height * dpr);
  els.overlay.style.width = `${rect.width}px`;
  els.overlay.style.height = `${rect.height}px`;
  drawOverlay();
}

function drawOverlay(tempRoi = null) {
  const c = els.overlay;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const roi = tempRoi || state.roi;
  if (!roi) return;
  const x = roi.x * c.width;
  const y = roi.y * c.height;
  const w = roi.w * c.width;
  const h = roi.h * c.height;
  ctx.save();
  ctx.fillStyle = 'rgba(4, 12, 22, .38)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.clearRect(x, y, w, h);
  ctx.strokeStyle = state.detecting ? '#ffb45c' : '#54e1d2';
  ctx.lineWidth = Math.max(3, c.width / 180);
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(8, 17, 31, .86)';
  ctx.fillRect(x, Math.max(0, y - 28), Math.min(w, 160), 26);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.max(13, c.width / 34)}px -apple-system, sans-serif`;
  ctx.fillText('WATER AREA', x + 8, Math.max(19, y - 9));
  ctx.restore();
}

function pointFromEvent(e) {
  const rect = els.cameraStage.getBoundingClientRect();
  const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
  return {
    x: Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (touch.clientY - rect.top) / rect.height))
  };
}

function normalizeRoi(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function startRoiSelection() {
  if (!state.cameraOn) return;
  stopDetection();
  state.selectingRoi = true;
  els.roiHint.classList.remove('hidden');
  setStatus('Drag a rectangle around a quiet part of the puddle. Make it at least 15% of the view.');
}

function roiPointerDown(e) {
  if (!state.selectingRoi) return;
  e.preventDefault();
  state.dragStart = pointFromEvent(e);
}

function roiPointerMove(e) {
  if (!state.selectingRoi || !state.dragStart) return;
  e.preventDefault();
  const current = pointFromEvent(e);
  drawOverlay(normalizeRoi(state.dragStart, current));
}

function roiPointerUp(e) {
  if (!state.selectingRoi || !state.dragStart) return;
  e.preventDefault();
  const roi = normalizeRoi(state.dragStart, pointFromEvent(e));
  state.dragStart = null;
  if (roi.w < 0.12 || roi.h < 0.10) {
    setStatus('That area is too small. Drag a larger rectangle over the puddle.');
    drawOverlay();
    return;
  }
  state.roi = roi;
  state.selectingRoi = false;
  state.calibrated = false;
  state.previousFrame = null;
  els.roiHint.classList.add('hidden');
  els.calibrateBtn.disabled = false;
  els.detectBtn.disabled = false;
  setStatus('Water area selected. Keep everything still, then calibrate.');
  saveLocal();
  drawOverlay();
}

function updateSensitivityUI() {
  const value = Number(els.sensitivity.value);
  els.sensitivityValue.value = value;
  els.sensitivityValue.textContent = value;
  const markerPct = Math.max(15, Math.min(90, 22 + value * 5.1));
  els.thresholdMarker.style.left = `${markerPct}%`;
}

function getMotionFrame() {
  if (!state.roi || els.camera.readyState < 2 || !els.camera.videoWidth) return null;
  const videoW = els.camera.videoWidth;
  const videoH = els.camera.videoHeight;
  const displayAspect = els.cameraStage.clientWidth / els.cameraStage.clientHeight;
  const videoAspect = videoW / videoH;

  // Convert ROI from object-fit: cover display coordinates to source video coordinates.
  let visibleX = 0, visibleY = 0, visibleW = videoW, visibleH = videoH;
  if (videoAspect > displayAspect) {
    visibleW = videoH * displayAspect;
    visibleX = (videoW - visibleW) / 2;
  } else {
    visibleH = videoW / displayAspect;
    visibleY = (videoH - visibleH) / 2;
  }

  const sx = visibleX + state.roi.x * visibleW;
  const sy = visibleY + state.roi.y * visibleH;
  const sw = state.roi.w * visibleW;
  const sh = state.roi.h * visibleH;

  const targetW = 128;
  const targetH = Math.min(180, Math.max(36, Math.round(targetW * sh / sw)));
  const canvas = els.analysisCanvas;
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(els.camera, sx, sy, sw, sh, 0, 0, targetW, targetH);
  const rgba = ctx.getImageData(0, 0, targetW, targetH).data;
  const gray = new Uint8Array(targetW * targetH);
  for (let p = 0, i = 0; i < rgba.length; i += 4, p++) {
    gray[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
  }
  return gray;
}

function analyzeMotion() {
  const frame = getMotionFrame();
  if (!frame) return;
  if (!state.previousFrame || state.previousFrame.length !== frame.length) {
    state.previousFrame = frame;
    return;
  }

  let sum = 0;
  let changed = 0;
  // Sample every second pixel for speed, ignoring tiny sensor noise.
  for (let i = 0; i < frame.length; i += 2) {
    const d = Math.abs(frame[i] - state.previousFrame[i]);
    sum += d;
    if (d > 7) changed++;
  }
  const samples = Math.ceil(frame.length / 2);
  const meanDiff = sum / samples;
  const changedPct = (changed / samples) * 100;
  const motion = meanDiff * 0.72 + changedPct * 0.28;
  state.previousFrame = frame;

  if (state.calibrating) {
    state.calibrationSamples.push(motion);
  } else if (!state.detecting) {
    // Quietly keep the meter responsive but do not change the calibrated baseline.
  } else {
    const std = Math.sqrt(Math.max(0.05, state.baselineVar));
    const threshold = state.baselineMean + Number(els.sensitivity.value) * std;
    const hardFloor = Math.max(0.7, state.baselineMean * 1.35);
    const isHot = motion > Math.max(threshold, hardFloor);
    if (isHot) {
      state.hotFrames += 1;
      state.quietFrames = 0;
    } else {
      state.hotFrames = 0;
      state.quietFrames += 1;
      if (state.quietFrames >= 4) state.motionArmed = true;
    }

    const now = performance.now();
    if (state.motionArmed && state.hotFrames >= 2 && now - state.lastAutoEventAt > 750) {
      state.lastAutoEventAt = now;
      state.hotFrames = 0;
      state.motionArmed = false;
      logDrop('auto', motion);
      flashDetection();
    }

    // Adapt only on quiet frames so real ripples do not become the new normal.
    if (!isHot) {
      const alpha = 0.018;
      const delta = motion - state.baselineMean;
      state.baselineMean += alpha * delta;
      state.baselineVar = (1 - alpha) * (state.baselineVar + alpha * delta * delta);
    }
  }

  const std = Math.sqrt(Math.max(0.05, state.baselineVar));
  const threshold = state.baselineMean + Number(els.sensitivity.value) * std;
  const displayMax = Math.max(4, threshold * 1.7, motion * 1.1);
  const pct = Math.min(100, motion / displayMax * 100);
  els.motionValue.textContent = motion.toFixed(2);
  els.motionFill.style.width = `${pct}%`;
  els.thresholdMarker.style.left = `${Math.min(94, threshold / displayMax * 100)}%`;
}

async function calibrate() {
  if (!state.cameraOn || !state.roi || state.calibrating) return;
  stopDetection();
  state.calibrating = true;
  state.calibrationSamples = [];
  state.previousFrame = null;
  els.calibrateBtn.disabled = true;
  els.detectBtn.disabled = true;
  const start = performance.now();
  const duration = 5000;
  setStatus('Calibrating: do not touch the phone, water, pumps, or lighting…');
  const timer = setInterval(() => {
    const left = Math.max(0, duration - (performance.now() - start));
    els.calibrateBtn.textContent = `Still… ${(left / 1000).toFixed(1)}s`;
  }, 100);
  if (!state.analysisTimer) state.analysisTimer = setInterval(analyzeMotion, 100);
  await new Promise(resolve => setTimeout(resolve, duration));
  clearInterval(timer);

  const samples = state.calibrationSamples.slice(8); // discard startup frames
  if (samples.length < 10) {
    state.calibrating = false;
    els.calibrateBtn.disabled = false;
    els.detectBtn.disabled = false;
    els.calibrateBtn.textContent = 'Calibrate still water';
    setStatus('Calibration failed because too few camera frames were available. Try again.');
    return;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const cutoff = Math.max(1, Math.floor(sorted.length * 0.85));
  const quiet = sorted.slice(0, cutoff); // reject accidental motion spikes
  const mean = quiet.reduce((a, b) => a + b, 0) / quiet.length;
  const variance = quiet.reduce((acc, x) => acc + (x - mean) ** 2, 0) / quiet.length;
  state.baselineMean = mean;
  state.baselineVar = Math.max(variance, 0.05);
  state.calibrated = true;
  state.calibrating = false;
  els.calibrateBtn.disabled = false;
  els.detectBtn.disabled = false;
  els.calibrateBtn.textContent = 'Recalibrate still water';
  setStatus(`Calibrated. Normal motion is ${mean.toFixed(2)}. Start detection, then test one pump state at a time.`);
}

function startDetection() {
  if (state.detecting) {
    stopDetection();
    return;
  }
  if (!state.cameraOn || !state.roi) return;
  if (!state.calibrated) {
    setStatus('Calibrate still water first. This prevents camera noise from being counted as drops.');
    return;
  }
  if (!state.sessionActive) startSession();
  state.detecting = true;
  state.previousFrame = null;
  state.hotFrames = 0;
  state.quietFrames = 4;
  state.motionArmed = true;
  if (!state.analysisTimer) state.analysisTimer = setInterval(analyzeMotion, 100);
  els.detectBtn.textContent = 'Stop detecting';
  els.detectBtn.classList.add('active');
  els.detectBadge.textContent = 'Watching ripples';
  els.detectBadge.classList.add('detecting');
  setStatus('Detection is active. Do not move the iPhone. Change one pump or water state at a time.');
  drawOverlay();
  requestWakeLock();
}

function stopDetection() {
  state.detecting = false;
  state.hotFrames = 0;
  state.quietFrames = 0;
  state.motionArmed = true;
  els.detectBtn.textContent = 'Start detecting';
  els.detectBtn.classList.remove('active');
  els.detectBadge.textContent = 'Detection off';
  els.detectBadge.classList.remove('detecting');
  drawOverlay();
  releaseWakeLock();
}

function flashDetection() {
  const old = els.cameraStage.style.boxShadow;
  els.cameraStage.style.boxShadow = 'inset 0 0 0 5px #ffb45c, 0 0 28px rgba(255,180,92,.55)';
  setTimeout(() => { els.cameraStage.style.boxShadow = old; }, 220);
  if (navigator.vibrate) navigator.vibrate(35);
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* optional API */ }
}

async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch (_) {}
  state.wakeLock = null;
}

function startSession() {
  if (state.sessionActive) {
    endSession();
    return;
  }
  state.sessionActive = true;
  state.sessionStartEpoch = Date.now();
  state.events = [];
  addEvent('session_start', { source: 'manual' });
  updateSessionUI();
  saveLocal();
}

function endSession() {
  if (!state.sessionActive) return;
  stopDetection();
  addEvent('session_end', { source: 'manual' });
  state.sessionActive = false;
  updateSessionUI();
  saveLocal();
}

function updateSessionUI() {
  els.sessionBtn.textContent = state.sessionActive ? 'End session' : 'Start session';
  els.manualDropBtn.disabled = !state.sessionActive;
  els.csvBtn.disabled = state.events.length === 0;
  els.jsonBtn.disabled = state.events.length === 0;
  els.shareBtn.disabled = state.events.length === 0;
  clearInterval(state.elapsedTimer);
  if (state.sessionActive && state.sessionStartEpoch) {
    const tick = () => { els.elapsedClock.textContent = formatClock(Date.now() - state.sessionStartEpoch); };
    tick();
    state.elapsedTimer = setInterval(tick, 1000);
  } else if (state.sessionStartEpoch) {
    const last = state.events.at(-1)?.epoch || Date.now();
    els.elapsedClock.textContent = formatClock(last - state.sessionStartEpoch);
  } else {
    els.elapsedClock.textContent = '00:00:00';
  }
}

function addEvent(type, extra = {}) {
  const epoch = Date.now();
  const event = {
    id: `${epoch}-${Math.random().toString(16).slice(2)}`,
    type,
    epoch,
    elapsedMs: state.sessionStartEpoch ? epoch - state.sessionStartEpoch : 0,
    context: eventContext(),
    ...extra
  };
  state.events.push(event);
  renderAll();
  saveLocal();
  return event;
}

function logDrop(source = 'manual', motionScore = null) {
  if (!state.sessionActive) startSession();
  const drops = state.events.filter(e => e.type === 'drop');
  const previous = drops.at(-1);
  const event = addEvent('drop', {
    source,
    motionScore: Number.isFinite(motionScore) ? Number(motionScore.toFixed(3)) : null,
    intervalMs: previous ? Date.now() - previous.epoch : null
  });
  return event;
}

function toggleMachineState(key) {
  state.machineStates[key] = !state.machineStates[key];
  updateStateButtons();
  if (state.sessionActive) addEvent('state_change', { changed: key, value: state.machineStates[key] });
  else saveLocal();
}

function updateStateButtons() {
  document.querySelectorAll('.state-btn').forEach(btn => {
    const key = btn.dataset.state;
    const on = Boolean(state.machineStates[key]);
    btn.classList.toggle('on', on);
    btn.querySelector('b').textContent = on ? 'ON' : 'OFF';
    btn.setAttribute('aria-pressed', String(on));
  });
}

function contextText(ctx) {
  const active = [];
  if (ctx.pump1) active.push('Pump 1');
  if (ctx.pump2) active.push('Pump 2');
  if (ctx.inlet) active.push('Inlet water');
  const states = active.length ? active.join(' + ') : 'All marked OFF';
  return ctx.label ? `${states} · ${ctx.label}` : states;
}

function eventTitle(e) {
  if (e.type === 'drop') return e.source === 'auto' ? 'Ripple detected' : 'Drop logged manually';
  if (e.type === 'session_start') return 'Session started';
  if (e.type === 'session_end') return 'Session ended';
  if (e.type === 'label_change') return `Test label changed to ${e.value || 'blank'}`;
  if (e.type === 'state_change') {
    const names = { pump1: 'Pump 1', pump2: 'Pump 2', inlet: 'Inlet water' };
    return `${names[e.changed]} turned ${e.value ? 'ON' : 'OFF'}`;
  }
  return e.type;
}

function renderTimeline() {
  if (!state.events.length) {
    els.timeline.innerHTML = '<p class="empty-copy">Start a session, then change pump states and log or detect drops.</p>';
    return;
  }
  const visible = [...state.events].reverse();
  els.timeline.innerHTML = visible.map(e => {
    const score = e.motionScore != null ? ` · motion ${e.motionScore}` : '';
    return `<article class="event">
      <time class="event-time">${formatClock(e.elapsedMs)}</time>
      <div class="event-main"><strong>${escapeHtml(eventTitle(e))}</strong><span>${escapeHtml(contextText(e.context))}${score}</span></div>
      <div class="event-gap">${e.intervalMs ? escapeHtml(formatDuration(e.intervalMs, true)) : ''}</div>
    </article>`;
  }).join('');
}

function dropIntervals() {
  return state.events.filter(e => e.type === 'drop' && Number.isFinite(e.intervalMs)).map(e => e.intervalMs);
}

function contextKey(ctx) {
  return JSON.stringify([Boolean(ctx.pump1), Boolean(ctx.pump2), Boolean(ctx.inlet), ctx.label || '']);
}

function stableIntervalGroups() {
  const groups = new Map();
  let previousDrop = null;
  let previousDropIndex = -1;
  state.events.forEach((event, index) => {
    if (event.type !== 'drop') return;
    if (previousDrop) {
      const changedBetween = state.events.slice(previousDropIndex + 1, index).some(e => e.type === 'state_change' || e.type === 'label_change');
      const sameContext = contextKey(previousDrop.context) === contextKey(event.context);
      if (!changedBetween && sameContext && Number.isFinite(event.intervalMs)) {
        const key = contextKey(event.context);
        if (!groups.has(key)) groups.set(key, { context: event.context, values: [] });
        groups.get(key).values.push(event.intervalMs);
      }
    }
    previousDrop = event;
    previousDropIndex = index;
  });
  return [...groups.values()].sort((a, b) => {
    const aa = a.values.reduce((x,y)=>x+y,0)/a.values.length;
    const bb = b.values.reduce((x,y)=>x+y,0)/b.values.length;
    return aa - bb;
  });
}

function renderComparison() {
  const groups = stableIntervalGroups();
  if (!groups.length) {
    els.comparison.innerHTML = '<p class="empty-copy">Keep the same pump state for at least two drops to compare it with other tests.</p>';
    return;
  }
  els.comparison.innerHTML = groups.map(group => {
    const avg = group.values.reduce((a,b)=>a+b,0)/group.values.length;
    const min = Math.min(...group.values), max = Math.max(...group.values);
    return `<article class="comparison-row">
      <div><strong>${escapeHtml(contextText(group.context))}</strong><span>${group.values.length} stable interval${group.values.length === 1 ? '' : 's'} · range ${escapeHtml(formatDuration(min))}–${escapeHtml(formatDuration(max))}</span></div>
      <div class="comparison-metric"><b>${escapeHtml(formatDuration(avg, true))}</b><small>average gap</small></div>
    </article>`;
  }).join('');
}

function renderStats() {
  const drops = state.events.filter(e => e.type === 'drop');
  const intervals = dropIntervals();
  els.statCount.textContent = drops.length;
  els.statLatest.textContent = intervals.length ? formatDuration(intervals.at(-1), true) : '—';
  if (intervals.length) {
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    els.statAverage.textContent = formatDuration(avg, true);
    els.statRange.textContent = `${formatDuration(Math.min(...intervals))}–${formatDuration(Math.max(...intervals))}`;
  } else {
    els.statAverage.textContent = '—';
    els.statRange.textContent = '—';
  }
}

function renderChart() {
  const values = dropIntervals().map(ms => ms / 1000);
  const canvas = els.intervalChart;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  els.chartEmpty.classList.toggle('hidden', values.length > 0);
  canvas.classList.toggle('hidden', values.length === 0);
  if (!values.length) return;

  const pad = { l: 38, r: 10, t: 16, b: 28 };
  const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
  const max = Math.max(2, ...values) * 1.15;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + plotH * i / 4;
    const val = max * (1 - i / 4);
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#98aac0';
    ctx.fillText(`${val.toFixed(0)}s`, pad.l - 7, y);
  }
  const xFor = i => values.length === 1 ? pad.l + plotW / 2 : pad.l + plotW * i / (values.length - 1);
  const yFor = v => pad.t + plotH * (1 - v / max);
  ctx.strokeStyle = '#54e1d2';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  values.forEach((v, i) => { const x=xFor(i), y=yFor(v); i ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
  ctx.stroke();
  values.forEach((v, i) => {
    const x=xFor(i), y=yFor(v);
    ctx.fillStyle = '#0e1b2b'; ctx.strokeStyle = '#ffb45c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x,y,4.5,0,Math.PI*2); ctx.fill(); ctx.stroke();
  });
  ctx.fillStyle = '#98aac0'; ctx.textAlign='center'; ctx.textBaseline='top';
  ctx.fillText('Drop intervals in order', pad.l + plotW/2, h - 17);
}

function renderAll() {
  renderTimeline();
  renderStats();
  renderComparison();
  renderChart();
  updateSessionUI();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

function clearSession() {
  if (!state.events.length) return;
  if (!confirm('Delete this session and all drop timestamps from this device?')) return;
  stopDetection();
  state.sessionActive = false;
  state.sessionStartEpoch = null;
  state.events = [];
  updateSessionUI();
  renderAll();
  saveLocal();
}

function csvText() {
  const rows = [['event_number','event_type','source','date_time','elapsed_seconds','interval_seconds','motion_score','pump_1','pump_2','inlet_water','test_label']];
  state.events.forEach((e, i) => rows.push([
    i + 1, e.type, e.source || '', new Date(e.epoch).toISOString(), (e.elapsedMs / 1000).toFixed(3),
    e.intervalMs == null ? '' : (e.intervalMs / 1000).toFixed(3), e.motionScore ?? '',
    e.context.pump1 ? 'ON' : 'OFF', e.context.pump2 ? 'ON' : 'OFF', e.context.inlet ? 'ON' : 'OFF', e.context.label || ''
  ]));
  return rows.map(row => row.map(v => `"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
}

function sessionFilename(ext) {
  const date = new Date(state.sessionStartEpoch || Date.now()).toISOString().replace(/[:.]/g, '-');
  return `leak-test-${date}.${ext}`;
}

function downloadBlob(content, type, filename) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() { downloadBlob(csvText(), 'text/csv;charset=utf-8', sessionFilename('csv')); }
function exportJson() {
  const payload = {
    app: 'Leak Drop Tracker', version: 1, exportedAt: new Date().toISOString(),
    sessionStart: state.sessionStartEpoch ? new Date(state.sessionStartEpoch).toISOString() : null,
    sensitivity: Number(els.sensitivity.value), baselineMean: state.baselineMean, baselineVariance: state.baselineVar,
    roi: state.roi, events: state.events
  };
  downloadBlob(JSON.stringify(payload, null, 2), 'application/json', sessionFilename('json'));
}

function reportText() {
  const drops = state.events.filter(e => e.type === 'drop');
  const intervals = dropIntervals();
  const avg = intervals.length ? intervals.reduce((a,b)=>a+b,0)/intervals.length : null;
  const lines = [
    'Leak Drop Tracker report',
    `Started: ${state.sessionStartEpoch ? new Date(state.sessionStartEpoch).toLocaleString() : '—'}`,
    `Drops: ${drops.length}`,
    `Latest interval: ${intervals.length ? formatDuration(intervals.at(-1), true) : '—'}`,
    `Average interval: ${avg ? formatDuration(avg, true) : '—'}`,
    '',
    'Drop timeline:'
  ];
  drops.forEach((e, i) => lines.push(`${i+1}. ${formatClock(e.elapsedMs)}${e.intervalMs ? ` (+${formatDuration(e.intervalMs, true)})` : ''} — ${contextText(e.context)}`));
  return lines.join('\n');
}

async function shareReport() {
  const csv = new File([csvText()], sessionFilename('csv'), { type: 'text/csv' });
  try {
    if (navigator.canShare?.({ files: [csv] })) {
      await navigator.share({ title: 'Leak Drop Tracker report', text: reportText(), files: [csv] });
    } else if (navigator.share) {
      await navigator.share({ title: 'Leak Drop Tracker report', text: reportText() });
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(reportText());
      setStatus('Report copied to the clipboard.');
    } else {
      exportCsv();
      setStatus('Sharing is unavailable in this browser, so the CSV was downloaded instead.');
    }
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`Could not share: ${err.message}`);
  }
}

// Events
els.cameraBtn.addEventListener('click', startCamera);
els.roiBtn.addEventListener('click', startRoiSelection);
els.calibrateBtn.addEventListener('click', calibrate);
els.detectBtn.addEventListener('click', startDetection);
els.sessionBtn.addEventListener('click', startSession);
els.manualDropBtn.addEventListener('click', () => logDrop('manual'));
els.sensitivity.addEventListener('input', () => { updateSensitivityUI(); saveLocal(); });
els.testLabel.addEventListener('change', () => {
  if (state.sessionActive) addEvent('label_change', { value: els.testLabel.value.trim() });
  else saveLocal();
});
els.clearBtn.addEventListener('click', clearSession);
els.csvBtn.addEventListener('click', exportCsv);
els.jsonBtn.addEventListener('click', exportJson);
els.shareBtn.addEventListener('click', shareReport);
els.helpBtn.addEventListener('click', () => els.helpDialog.showModal());
document.querySelectorAll('.state-btn').forEach(btn => btn.addEventListener('click', () => toggleMachineState(btn.dataset.state)));

els.cameraStage.addEventListener('pointerdown', roiPointerDown, { passive:false });
els.cameraStage.addEventListener('pointermove', roiPointerMove, { passive:false });
els.cameraStage.addEventListener('pointerup', roiPointerUp, { passive:false });
els.cameraStage.addEventListener('pointercancel', roiPointerUp, { passive:false });

window.addEventListener('resize', () => { resizeOverlay(); renderChart(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.detecting) requestWakeLock();
  else releaseWakeLock();
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
}

updateSensitivityUI();
loadLocal();
renderAll();
