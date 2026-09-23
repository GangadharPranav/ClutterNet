/**
 * ClutterNet Tactical Radar Evaluator - Real-Time Dashboard Engine
 * Pure Vanilla JavaScript: Zero-dependency, 60+ FPS, Hardware-accelerated Canvas.
 */

// --- 1. COLORMAP LOOKUP TABLES (256 RGBA Entries) ---
function hexToRgb(hex) {
  const c = parseInt(hex.replace('#', ''), 16);
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

function interpolateColors(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

function buildLut(stops) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const norm = i / 255;
    let idx = 0;
    while (idx < stops.length - 2 && norm > stops[idx + 1].pos) idx++;
    const s1 = stops[idx];
    const s2 = stops[idx + 1];
    const range = s2.pos - s1.pos;
    const t = range === 0 ? 0 : Math.max(0, Math.min(1, (norm - s1.pos) / range));
    const rgb = interpolateColors(s1.rgb, s2.rgb, t);
    const p = i * 4;
    lut[p] = rgb[0];
    lut[p + 1] = rgb[1];
    lut[p + 2] = rgb[2];
    lut[p + 3] = 255;
  }
  return lut;
}

const COLORMAPS = {
  phosphor: buildLut([
    { pos: 0.0, rgb: hexToRgb('#020b06') },
    { pos: 0.15, rgb: hexToRgb('#052514') },
    { pos: 0.45, rgb: hexToRgb('#0c6e3b') },
    { pos: 0.75, rgb: hexToRgb('#00df68') },
    { pos: 0.95, rgb: hexToRgb('#66ffb2') },
    { pos: 1.0, rgb: hexToRgb('#ffffff') }
  ]),
  jet: buildLut([
    { pos: 0.0, rgb: hexToRgb('#03071e') },
    { pos: 0.2, rgb: hexToRgb('#023e8a') },
    { pos: 0.4, rgb: hexToRgb('#0096c7') },
    { pos: 0.6, rgb: hexToRgb('#52b788') },
    { pos: 0.8, rgb: hexToRgb('#ffb703') },
    { pos: 0.95, rgb: hexToRgb('#d90429') },
    { pos: 1.0, rgb: hexToRgb('#ffffff') }
  ]),
  cyan: buildLut([
    { pos: 0.0, rgb: hexToRgb('#030d17') },
    { pos: 0.2, rgb: hexToRgb('#06334a') },
    { pos: 0.5, rgb: hexToRgb('#008eb0') },
    { pos: 0.8, rgb: hexToRgb('#00e5ff') },
    { pos: 0.95, rgb: hexToRgb('#99f4ff') },
    { pos: 1.0, rgb: hexToRgb('#ffffff') }
  ]),
  plasma: buildLut([
    { pos: 0.0, rgb: hexToRgb('#0c0721') },
    { pos: 0.25, rgb: hexToRgb('#4e0c70') },
    { pos: 0.55, rgb: hexToRgb('#9d246c') },
    { pos: 0.8, rgb: hexToRgb('#eb6a33') },
    { pos: 0.95, rgb: hexToRgb('#f8ba39') },
    { pos: 1.0, rgb: hexToRgb('#ffffff') }
  ])
};

// --- 2. RADAR SIMULATION & SIGNAL PROCESSING ENGINE ---
class RadarEngine {
  constructor(w = 140, h = 105) {
    this.w = w;
    this.h = h;
    this.size = w * h;

    this.minRange = 2.0;
    this.maxRange = 25.0;
    this.minDoppler = -35.0;
    this.maxDoppler = 35.0;

    // Controls
    this.seaState = 3;
    this.targetSCR = 10;
    this.failSafeMode = false;
    this.sweepSpeed = 'normal';

    // Target Location
    this.targetRangeBin = Math.floor(w * 0.55); // ~14.6 km
    this.targetDopplerBin = Math.floor(h * 0.65); // ~+11.5 m/s

    // Buffers
    this.rawMap = new Float32Array(this.size);
    this.cfarMap = new Float32Array(this.size);
    this.clutterNetMap = new Float32Array(this.size);
    this.thresholdMap = new Float32Array(this.size);
    this.detections = new Uint8Array(this.size);

    this.frameCount = 0;
    this.cfarAlarmCount = 0;
    this.netAlarmCount = 0;
    this.activeColormap = 'phosphor';
    this.sliceMode = 'range'; // 'range' or 'doppler'
  }

  setTargetPreset(preset) {
    switch (preset) {
      case 'closeFast':
        this.targetRangeBin = Math.floor(this.w * 0.25);
        this.targetDopplerBin = Math.floor(this.h * 0.85);
        break;
      case 'distantSlow':
        this.targetRangeBin = Math.floor(this.w * 0.85);
        this.targetDopplerBin = Math.floor(this.h * 0.54);
        break;
      case 'zeroDoppler':
        this.targetRangeBin = Math.floor(this.w * 0.60);
        this.targetDopplerBin = Math.floor(this.h * 0.50);
        break;
      default: // 'center'
        this.targetRangeBin = Math.floor(this.w * 0.55);
        this.targetDopplerBin = Math.floor(this.h * 0.65);
    }
  }

  step() {
    if (this.sweepSpeed === 'pause') return;
    const speedMult = this.sweepSpeed === 'fast' ? 1.8 : 1.0;
    this.frameCount += speedMult;

    const W = this.w;
    const H = this.h;
    const t = this.frameCount * 0.045;

    // Physical clutter parameters based on WMO Sea State
    const seaParams = {
      2: { power: 0.15, spread: 3.5, spikeRate: 0.006, spikeAmp: 0.32, freq: 1.0 },
      3: { power: 0.32, spread: 7.5, spikeRate: 0.025, spikeAmp: 0.55, freq: 1.4 },
      4: { power: 0.54, spread: 14.0, spikeRate: 0.080, spikeAmp: 0.82, freq: 1.9 },
      5: { power: 0.82, spread: 23.0, spikeRate: 0.190, spikeAmp: 1.00, freq: 2.6 }
    }[this.seaState] || { power: 0.32, spread: 7.5, spikeRate: 0.025, spikeAmp: 0.55, freq: 1.4 };

    const zeroD = Math.floor(H / 2);
    const dSigma = (seaParams.spread / 70.0) * H;

    let cfarAlarms = 0;
    let netAlarms = 0;

    // 1. Synthesize Raw Range-Doppler Map
    for (let y = 0; y < H; y++) {
      const dDist = y - zeroD;
      const dEnvelope = Math.exp(-(dDist * dDist) / (2 * dSigma * dSigma));

      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const thermal = 0.04 * (0.8 + 0.4 * Math.random());

        // K-distribution: texture (gamma/wave surface) * speckle (exponential)
        const wave = Math.sin(x * 0.16 + t * seaParams.freq) * Math.cos(y * 0.11 - t * 0.8 * seaParams.freq);
        const texture = Math.max(0, 0.4 + 0.6 * wave);
        const speckle = -Math.log(Math.max(1e-5, Math.random()));
        let clutter = seaParams.power * dEnvelope * texture * speckle * 0.42;

        // Sea spike bursts (intermittent high amplitude whitecaps)
        if (Math.random() < seaParams.spikeRate) {
          clutter += (0.5 + 0.5 * Math.random()) * seaParams.spikeAmp;
        }

        let val = thermal + clutter;

        // Buried Target injection
        const dx = x - this.targetRangeBin;
        const dy = y - this.targetDopplerBin;
        const distSq = dx * dx + dy * dy;

        if (distSq < 16) {
          const targetLinear = Math.pow(10, (this.targetSCR - 10) / 20) * 0.78;
          const psf = Math.exp(-distSq / 3.4);
          const flutter = 1.0 + 0.06 * Math.sin(t * 3.2);
          val += targetLinear * psf * flutter;
        }

        this.rawMap[idx] = Math.min(1.0, val);
      }
    }

    // 2. Legacy CA-CFAR (Cell-Averaging 2D Sliding Window)
    const G = 2; // Guard cells
    const R = 4; // Reference cells
    const Pfa_nominal = 1e-3;
    const refCellsCount = (2 * R + 1) * (2 * R + 1) - (2 * G + 1) * (2 * G + 1);
    const alpha = refCellsCount * (Math.pow(Pfa_nominal, -1.0 / refCellsCount) - 1.0) * 1.35;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const cut = this.rawMap[idx];

        let sum = 0;
        let count = 0;

        for (let dy = -R; dy <= R; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (Math.abs(dx) <= G && Math.abs(dy) <= G) continue;
            sum += this.rawMap[ny * W + nx];
            count++;
          }
        }

        const avgNoise = count > 0 ? sum / count : 0.08;
        const threshold = avgNoise * (1.0 + alpha * 0.22);
        this.thresholdMap[idx] = threshold;

        if (cut > threshold) {
          this.detections[idx] = 1;
          this.cfarMap[idx] = Math.min(1.0, 0.45 + (cut - threshold) * 2.2);

          const distToTarget = Math.hypot(x - this.targetRangeBin, y - this.targetDopplerBin);
          if (distToTarget > 4) cfarAlarms++;
        } else {
          this.detections[idx] = 0;
          this.cfarMap[idx] = Math.max(0, cut * 0.16);
        }
      }
    }

    // 3. ClutterNet Deep Neural Filter & Fallback Simulation
    const isFallback = this.failSafeMode;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const raw = this.rawMap[idx];
        const distToTarget = Math.hypot(x - this.targetRangeBin, y - this.targetDopplerBin);

        if (isFallback) {
          // Instant autonomous fallback to baseline CFAR
          this.clutterNetMap[idx] = this.cfarMap[idx];
          if (this.detections[idx] && distToTarget > 4) netAlarms++;
        } else {
          // ClutterNet suppresses background clutter by ~14 dB
          const suppressedClutter = Math.max(0, (raw - 0.07) * 0.035);
          const cleanNoise = 0.012 * Math.random();

          if (distToTarget < 3.2) {
            const shape = Math.exp(-(distToTarget * distToTarget) / 2.2);
            const amp = Math.max(0.60, 0.50 + (this.targetSCR / 15.0) * 0.48);
            this.clutterNetMap[idx] = Math.min(1.0, amp * shape + cleanNoise);
          } else {
            this.clutterNetMap[idx] = Math.min(1.0, suppressedClutter + cleanNoise);
          }
        }
      }
    }

    this.cfarAlarmCount = cfarAlarms;
    this.netAlarmCount = netAlarms;
  }

  getMetrics() {
    const isFallback = this.failSafeMode;
    const time = this.frameCount * 0.05;
    const jitter = 0.3 * Math.sin(time);

    if (isFallback) {
      return {
        latency: (4.2 + jitter * 0.2).toFixed(1),
        gain: '0.0',
        pfa: (this.cfarAlarmCount / (this.size - 16)).toExponential(1),
        mode: 'FAIL-SAFE: BASELINE CA-CFAR ENGAGED',
        isFallback: true,
        confidence: 'FALLBACK'
      };
    } else {
      const netPfa = this.seaState <= 3 ? '< 10⁻⁶' : (this.seaState === 4 ? '< 5×10⁻⁶' : '< 10⁻⁵');
      const gain = (14.2 + (this.seaState - 3) * 0.8).toFixed(1);
      return {
        latency: (18.4 + jitter).toFixed(1),
        gain: `+${gain}`,
        pfa: netPfa,
        mode: 'HYBRID AI-CFAR ACTIVE',
        isFallback: false,
        confidence: '98.8%'
      };
    }
  }

  getCoordinates(normX, normY) {
    const rangeKm = this.minRange + normX * (this.maxRange - this.minRange);
    const dopplerMs = this.minDoppler + (1.0 - normY) * (this.maxDoppler - this.minDoppler);

    const bx = Math.floor(normX * (this.w - 1));
    const by = Math.floor(normY * (this.h - 1));
    const idx = by * this.w + bx;

    const raw = this.rawMap[idx] || 0;
    const net = this.clutterNetMap[idx] || 0;

    return {
      rangeKm: rangeKm.toFixed(2),
      dopplerMs: (dopplerMs >= 0 ? '+' : '') + dopplerMs.toFixed(1),
      rawDbm: (-85 + raw * 52).toFixed(1),
      netDbm: (-95 + net * 52).toFixed(1),
      binX: bx,
      binY: by
    };
  }
}

// --- 3. WEB AUDIO TACTICAL FEEDBACK ---
class TacticalAudio {
  constructor() {
    this.ctx = null;
    this.muted = true;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggle() {
    this.init();
    this.muted = !this.muted;
    if (!this.muted) this.playTone(880, 0.1, 0.05);
    return !this.muted;
  }

  playTone(freq, dur = 0.1, vol = 0.04) {
    if (this.muted || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
    } catch {
      // Audio policy safe
    }
  }

  playWarning() {
    if (this.muted || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.setValueAtTime(320, t + 0.1);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    } catch {
      // Audio policy safe
    }
  }
}

// --- 4. DASHBOARD CONTROLLER & UI WIRING ---
document.addEventListener('DOMContentLoaded', () => {
  const engine = new RadarEngine(140, 105);
  const audio = new TacticalAudio();

  // Canvases
  const canvasRaw = document.getElementById('canvasRaw');
  const canvasCfar = document.getElementById('canvasCfar');
  const canvasNet = document.getElementById('canvasNet');
  const canvas1D = document.getElementById('canvas1D');

  const ctxRaw = canvasRaw.getContext('2d');
  const ctxCfar = canvasCfar.getContext('2d');
  const ctxNet = canvasNet.getContext('2d');
  const ctx1D = canvas1D.getContext('2d');

  // Offscreen ImageDatas for fast blitting
  const imgDataRaw = ctxRaw.createImageData(engine.w, engine.h);
  const imgDataCfar = ctxCfar.createImageData(engine.w, engine.h);
  const imgDataNet = ctxNet.createImageData(engine.w, engine.h);

  // Crosshairs & Markers
  const crosshairs = {
    hRaw: document.getElementById('crosshairHRaw'),
    vRaw: document.getElementById('crosshairVRaw'),
    hCfar: document.getElementById('crosshairHCfar'),
    vCfar: document.getElementById('crosshairVCfar'),
    hNet: document.getElementById('crosshairHNet'),
    vNet: document.getElementById('crosshairVNet')
  };

  const netReticle = document.getElementById('netReticle');
  const failSafeOverlay = document.getElementById('failSafeOverlay');

  // Readouts
  const readoutRange = document.getElementById('readoutRange');
  const readoutDoppler = document.getElementById('readoutDoppler');
  const readoutRawDbm = document.getElementById('readoutRawDbm');
  const readoutNetDbm = document.getElementById('readoutNetDbm');
  const readoutBin = document.getElementById('readoutBin');

  // HUD Metrics
  const metricLatency = document.getElementById('metricLatency');
  const metricGain = document.getElementById('metricGain');
  const metricPfa = document.getElementById('metricPfa');
  const cfarPfaCompare = document.getElementById('cfarPfaCompare');
  const modeIndicator = document.getElementById('modeIndicator');
  const modeText = document.getElementById('modeText');
  const modeSub = document.getElementById('modeSub');

  // Control Elements
  const seaStateSlider = document.getElementById('seaStateSlider');
  const seaStateBadge = document.getElementById('seaStateValueBadge');
  const seaStateDesc = document.getElementById('seaStateDesc');

  const scrSlider = document.getElementById('scrSlider');
  const scrBadge = document.getElementById('scrValueBadge');
  const scrDesc = document.getElementById('scrDesc');

  const failSafeToggle = document.getElementById('failSafeToggle');
  const failSafeIndicator = document.getElementById('failSafeIndicator');
  const failSafeStatusText = document.getElementById('failSafeStatusText');

  const targetPosSelect = document.getElementById('targetPosSelect');
  const sweepSpeedSelect = document.getElementById('sweepSpeedSelect');

  const cfarAlarmCount = document.getElementById('cfarAlarmCount');
  const cfarTargetStatus = document.getElementById('cfarTargetStatus');
  const netStatusPill = document.getElementById('netStatusPill');
  const netBgStatus = document.getElementById('netBgStatus');
  const netConfidence = document.getElementById('netConfidence');

  // Audio Toggle
  const audioToggleBtn = document.getElementById('audioToggleBtn');
  const audioIcon = document.getElementById('audioIcon');
  const audioLabel = document.getElementById('audioLabel');

  audioToggleBtn.addEventListener('click', () => {
    const isUnmuted = audio.toggle();
    if (isUnmuted) {
      audioToggleBtn.classList.add('active');
      audioIcon.textContent = '🔊';
      audioLabel.textContent = 'AUDIO ON';
    } else {
      audioToggleBtn.classList.remove('active');
      audioIcon.textContent = '🔇';
      audioLabel.textContent = 'AUDIO OFF';
    }
  });

  // Sea State Slider Handler
  const seaStateDescriptions = {
    2: {
      badge: 'STATE 2 (Calm Seas)',
      desc: 'Significant wave height ~0.3m. Smooth ripples, low Bragg scatter power. Legacy CA-CFAR operates nominally with rare false alarms.'
    },
    3: {
      badge: 'STATE 3 (Moderate Seas)',
      desc: 'Wave height ~1.2m. Moderate Bragg scattering and scattered whitecaps. CA-CFAR begins exhibiting sea spike false alarms.'
    },
    4: {
      badge: 'STATE 4 (Rough Seas)',
      desc: 'Wave height ~2.2m. Strong whitecaps and severe sea spikes. CA-CFAR threshold rises steeply, masking targets below 8 dB SCR.'
    },
    5: {
      badge: 'STATE 5 (Storm / Gale)',
      desc: 'Wave height ~3.8m. Heavy white whitecaps, wide Doppler broadening. Legacy CFAR breaks down with dozens of false alarm blips.'
    }
  };

  seaStateSlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    engine.seaState = val;
    seaStateBadge.textContent = seaStateDescriptions[val].badge;
    seaStateDesc.textContent = seaStateDescriptions[val].desc;
  });

  // Target SCR Slider Handler
  scrSlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    engine.targetSCR = val;
    scrBadge.textContent = `${val.toFixed(1)} dB (${val <= 6 ? 'Stealth Threat' : (val <= 10 ? 'Standard Craft' : 'Large Vessel')})`;
    if (val <= 7) {
      scrDesc.textContent = `SCR is critically low. In legacy CFAR, target is submerged under sea clutter floor. ClutterNet isolates echo with +14.2 dB margin.`;
    } else {
      scrDesc.textContent = `Target echo power relative to mean ocean clutter. At <8 dB, legacy CFAR completely drops target while ClutterNet isolates it.`;
    }
  });

  // Fail-Safe Toggle Handler
  failSafeToggle.addEventListener('change', (e) => {
    const isFailsafe = e.target.checked;
    engine.failSafeMode = isFailsafe;

    if (isFailsafe) {
      audio.playWarning();
      failSafeIndicator.classList.add('alert');
      failSafeStatusText.textContent = 'UNCERTAINTY SPIKE (>0.42) // AUTONOMOUS FALLBACK TO CA-CFAR ENGAGED';
      failSafeOverlay.style.display = 'flex';
      netStatusPill.className = 'card-status status-warn';
      netStatusPill.textContent = 'FAIL-SAFE: CA-CFAR ACTIVE';
      netBgStatus.textContent = 'CFAR Baseline (Zero Dropout)';
      netConfidence.textContent = 'FALLBACK';
      netReticle.style.display = 'none';
    } else {
      failSafeIndicator.classList.remove('alert');
      failSafeStatusText.textContent = 'FAIL-SAFE STANDBY // Epistemic Uncertainty < 0.18 [NOMINAL]';
      failSafeOverlay.style.display = 'none';
      netStatusPill.className = 'card-status status-green';
      netStatusPill.textContent = 'Target Isolated Cleanly';
      netBgStatus.textContent = 'Floor Suppressed (-14dB)';
      netConfidence.textContent = '98.8%';
      netReticle.style.display = 'block';
    }
  });

  // Target Injection Preset
  targetPosSelect.addEventListener('change', (e) => {
    engine.setTargetPreset(e.target.value);
  });

  // Sweep Speed Select
  sweepSpeedSelect.addEventListener('change', (e) => {
    engine.sweepSpeed = e.target.value;
  });

  // Palette Selector
  const paletteBtns = document.querySelectorAll('.palette-btn');
  paletteBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      paletteBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      engine.activeColormap = btn.dataset.map;
    });
  });

  // 1D Cut Mode Toggle
  const btnSliceRange = document.getElementById('btnSliceRange');
  const btnSliceDoppler = document.getElementById('btnSliceDoppler');

  btnSliceRange.addEventListener('click', () => {
    btnSliceRange.classList.add('active');
    btnSliceDoppler.classList.remove('active');
    engine.sliceMode = 'range';
  });

  btnSliceDoppler.addEventListener('click', () => {
    btnSliceDoppler.classList.add('active');
    btnSliceRange.classList.remove('active');
    engine.sliceMode = 'doppler';
  });

  // Interactive Crosshair Coordination Across 3 Heatmaps
  const containers = [
    document.getElementById('cardRaw').querySelector('.canvas-container'),
    document.getElementById('cardCfar').querySelector('.canvas-container'),
    document.getElementById('cardNet').querySelector('.canvas-container')
  ];

  function handleMouseMove(e, container) {
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    const normX = x / rect.width;
    const normY = y / rect.height;

    // Position crosshairs on all 3 canvases
    const pctX = `${(normX * 100).toFixed(2)}%`;
    const pctY = `${(normY * 100).toFixed(2)}%`;

    crosshairs.hRaw.style.top = pctY;
    crosshairs.vRaw.style.left = pctX;
    crosshairs.hCfar.style.top = pctY;
    crosshairs.vCfar.style.left = pctX;
    crosshairs.hNet.style.top = pctY;
    crosshairs.vNet.style.left = pctX;

    crosshairs.hRaw.style.display = 'block';
    crosshairs.vRaw.style.display = 'block';
    crosshairs.hCfar.style.display = 'block';
    crosshairs.vCfar.style.display = 'block';
    crosshairs.hNet.style.display = 'block';
    crosshairs.vNet.style.display = 'block';

    // Live Readout Bar
    const coords = engine.getCoordinates(normX, normY);
    readoutRange.textContent = `${coords.rangeKm} km`;
    readoutDoppler.textContent = `${coords.dopplerMs} m/s`;
    readoutRawDbm.textContent = `${coords.rawDbm} dBm`;
    readoutNetDbm.textContent = `${coords.netDbm} dBm`;
    readoutBin.textContent = `Bin [${coords.binX}, ${coords.binY}]`;
  }

  function handleMouseLeave() {
    crosshairs.hRaw.style.display = 'none';
    crosshairs.vRaw.style.display = 'none';
    crosshairs.hCfar.style.display = 'none';
    crosshairs.vCfar.style.display = 'none';
    crosshairs.hNet.style.display = 'none';
    crosshairs.vNet.style.display = 'none';
  }

  containers.forEach(c => {
    c.addEventListener('mousemove', (e) => handleMouseMove(e, c));
    c.addEventListener('mouseleave', handleMouseLeave);
  });

  // Pipeline Stages Interactive Inspector (Block 4)
  const stageData = {
    iq: {
      tag: 'STAGE 01: RADAR I/Q STREAM INGESTION',
      rate: '100 MHz ADCs // sFPDP / PCIe Gen4 Bus',
      desc: 'Direct hardware ingest of raw coherent In-Phase and Quadrature pulse sequences from the naval receiver into shared GPU host pinned memory.',
      specs: [
        { lbl: 'Dimension', val: '1024 × 128 × 2' },
        { lbl: 'Latency', val: '1.2 ms' },
        { lbl: 'Bus Speed', val: '64 Gbps' }
      ]
    },
    fft: {
      tag: 'STAGE 02: 2D PULSE-DOPPLER FFT & CALIBRATION',
      rate: 'cuFFT Kernel on Embedded Tensor Cores',
      desc: 'Windowed 2D fast Fourier transform converting time-domain pulses into Range-Doppler representations while preserving inter-pulse phase coherence.',
      specs: [
        { lbl: 'Matrix', val: '1024 × 128' },
        { lbl: 'Windowing', val: 'Chebyshev (-60dB)' },
        { lbl: 'Exec Time', val: '2.4 ms' }
      ]
    },
    unet: {
      tag: 'STAGE 03: CLUTTERNET SPATIO-TEMPORAL FILTER',
      rate: 'TensorRT FP16 Inference on NVIDIA Jetson AGX Orin',
      desc: 'Deep multi-scale complex U-Net with temporal attention gates. Learns non-Rayleigh ocean clutter correlation and suppresses sea spikes by +14.2 dB.',
      specs: [
        { lbl: 'Model Params', val: '4.8M FP16' },
        { lbl: 'Inference', val: '18.4 ms' },
        { lbl: 'Suppression', val: '+14.2 dB' }
      ]
    },
    failsafe: {
      tag: 'STAGE 04: EPISTEMIC UNCERTAINTY & FAIL-SAFE GATE',
      rate: 'Monte Carlo Dropout & Confidence Scoring',
      desc: 'Evaluates epistemic variance across latent feature maps. If jamming or out-of-distribution wave states exceed tau = 0.42, instantly fallbacks to CA-CFAR.',
      specs: [
        { lbl: 'Threshold (tau)', val: '0.42' },
        { lbl: 'Switch Time', val: '< 0.1 ms' },
        { lbl: 'Dropout Risk', val: '0.0% (Guaranteed)' }
      ]
    },
    display: {
      tag: 'STAGE 05: ADAPTIVE CFAR & TACTICAL DISPLAY',
      rate: 'Combat Management System (CMS) Integration',
      desc: 'Performs low-threshold target extraction on cleaned background and transmits validated track telemetry to the shipboard command tactical console.',
      specs: [
        { lbl: 'Output', val: 'Track Vectors (ASTERIX)' },
        { lbl: 'Pfa Target', val: '< 10^-5' },
        { lbl: 'Pd (Weak)', val: '98.8%' }
      ]
    }
  };

  const stageSteps = document.querySelectorAll('.stage-step');
  const stageTag = document.getElementById('stageTag');
  const stageRate = document.getElementById('stageRate');
  const stageText = document.getElementById('stageText');
  const stageSpecsGrid = document.getElementById('stageSpecsGrid');

  stageSteps.forEach(step => {
    step.addEventListener('click', () => {
      stageSteps.forEach(s => s.classList.remove('active'));
      step.classList.add('active');
      const st = stageData[step.dataset.stage];
      if (st) {
        stageTag.textContent = st.tag;
        stageRate.textContent = st.rate;
        stageText.textContent = st.desc;
        stageSpecsGrid.innerHTML = st.specs.map(sp => `<div class="spec-pill"><strong>${sp.lbl}:</strong> ${sp.val}</div>`).join('');
      }
    });
  });

  // --- 5. RENDER LOOP ---
  function renderHeatmap(buffer, imgData, ctx, lut) {
    const data = imgData.data;
    const len = buffer.length;

    for (let i = 0; i < len; i++) {
      const val = Math.max(0, Math.min(1, buffer[i]));
      const lutIdx = Math.floor(val * 255) * 4;
      const p = i * 4;
      data[p] = lut[lutIdx];
      data[p + 1] = lut[lutIdx + 1];
      data[p + 2] = lut[lutIdx + 2];
      data[p + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);

    // Draw Tactical Grid Overlay on Canvas
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    // 4 vertical range lines
    for (let i = 1; i <= 3; i++) {
      const x = (w / 4) * i;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }

    // 2 horizontal Doppler velocity lines
    for (let i = 1; i <= 2; i++) {
      const y = (h / 3) * i;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    // Center Zero-Doppler Line
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  function render1DGraph() {
    const W = canvas1D.width;
    const H = canvas1D.height;
    ctx1D.clearRect(0, 0, W, H);

    // Graph Background Grid
    ctx1D.fillStyle = '#03070d';
    ctx1D.fillRect(0, 0, W, H);

    ctx1D.strokeStyle = 'rgba(25, 45, 70, 0.6)';
    ctx1D.lineWidth = 1;
    ctx1D.beginPath();
    for (let y = 30; y < H; y += 30) {
      ctx1D.moveTo(0, y);
      ctx1D.lineTo(W, y);
    }
    for (let x = 80; x < W; x += 80) {
      ctx1D.moveTo(x, 0);
      ctx1D.lineTo(x, H);
    }
    ctx1D.stroke();

    const isRange = engine.sliceMode === 'range';
    const numPoints = isRange ? engine.w : engine.h;
    const sliceY = engine.targetDopplerBin;
    const sliceX = engine.targetRangeBin;

    // Trace 1: Raw Signal with Clutter
    ctx1D.strokeStyle = '#5a7596';
    ctx1D.lineWidth = 1.2;
    ctx1D.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const idx = isRange ? (sliceY * engine.w + i) : (i * engine.w + sliceX);
      const val = engine.rawMap[idx];
      const px = (i / (numPoints - 1)) * W;
      const py = H - (val * (H - 20) + 10);
      if (i === 0) ctx1D.moveTo(px, py); else ctx1D.lineTo(px, py);
    }
    ctx1D.stroke();

    // Trace 2: CFAR Adaptive Threshold
    ctx1D.strokeStyle = '#ffb700';
    ctx1D.lineWidth = 1.8;
    ctx1D.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const idx = isRange ? (sliceY * engine.w + i) : (i * engine.w + sliceX);
      const val = engine.thresholdMap[idx];
      const px = (i / (numPoints - 1)) * W;
      const py = H - (val * (H - 20) + 10);
      if (i === 0) ctx1D.moveTo(px, py); else ctx1D.lineTo(px, py);
    }
    ctx1D.stroke();

    // Trace 3: ClutterNet Neural Filter Clean Floor & Peak
    ctx1D.strokeStyle = '#00ff88';
    ctx1D.lineWidth = 2.2;
    ctx1D.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const idx = isRange ? (sliceY * engine.w + i) : (i * engine.w + sliceX);
      const val = engine.clutterNetMap[idx];
      const px = (i / (numPoints - 1)) * W;
      const py = H - (val * (H - 20) + 10);
      if (i === 0) ctx1D.moveTo(px, py); else ctx1D.lineTo(px, py);
    }
    ctx1D.stroke();

    // Target Peak Highlight Mark
    const targetIdx = isRange ? engine.targetRangeBin : engine.targetDopplerBin;
    const targetPx = (targetIdx / (numPoints - 1)) * W;
    const peakIdx = isRange ? (sliceY * engine.w + targetIdx) : (targetIdx * engine.w + sliceX);
    const peakVal = engine.clutterNetMap[peakIdx];
    const targetPy = H - (peakVal * (H - 20) + 10);

    ctx1D.fillStyle = '#ffffff';
    ctx1D.beginPath();
    ctx1D.arc(targetPx, targetPy, 4.5, 0, Math.PI * 2);
    ctx1D.fill();
    ctx1D.strokeStyle = '#00ff88';
    ctx1D.lineWidth = 2;
    ctx1D.stroke();

    // Axis label watermark on 1D graph
    ctx1D.fillStyle = 'rgba(141, 164, 190, 0.7)';
    ctx1D.font = '10px "JetBrains Mono"';
    ctx1D.fillText(isRange ? 'RANGE AXIS: 2.0 km ─────── Target @ 14.6 km ─────── 25.0 km' : 'DOPPLER AXIS: -35.0 m/s ─────── Target @ +11.5 m/s ─────── +35.0 m/s', 12, 18);
  }

  function updateTacticalReticle() {
    if (engine.failSafeMode) {
      netReticle.style.display = 'none';
      return;
    }
    netReticle.style.display = 'block';
    const pctX = (engine.targetRangeBin / (engine.w - 1)) * 100;
    const pctY = (engine.targetDopplerBin / (engine.h - 1)) * 100;
    netReticle.style.left = `${pctX.toFixed(2)}%`;
    netReticle.style.top = `${pctY.toFixed(2)}%`;
  }

  // Animation Loop (60 FPS)
  function animate() {
    engine.step();

    const lut = COLORMAPS[engine.activeColormap] || COLORMAPS.phosphor;

    // 1. Render 3 heatmaps
    renderHeatmap(engine.rawMap, imgDataRaw, ctxRaw, lut);
    renderHeatmap(engine.cfarMap, imgDataCfar, ctxCfar, lut);
    renderHeatmap(engine.clutterNetMap, imgDataNet, ctxNet, lut);

    // 2. Render 1D slice graph
    render1DGraph();

    // 3. Update reticle position
    updateTacticalReticle();

    // 4. Update HUD Telemetry
    const metrics = engine.getMetrics();
    metricLatency.textContent = metrics.latency;
    metricGain.textContent = metrics.gain;
    metricPfa.textContent = metrics.pfa;
    cfarAlarmCount.textContent = engine.cfarAlarmCount;

    const cfarPfaRate = (engine.cfarAlarmCount / (engine.size - 16));
    cfarPfaCompare.textContent = `${cfarPfaRate.toExponential(1)}`;

    if (metrics.isFallback) {
      modeIndicator.className = 'metric-val mode-pill fallback-active';
      modeText.textContent = 'FAIL-SAFE: CA-CFAR ENGAGED';
      modeSub.textContent = 'ZERO MISSION DROPOUT';
      cfarTargetStatus.textContent = 'Baseline CFAR Active';
    } else {
      modeIndicator.className = 'metric-val mode-pill';
      modeText.textContent = 'HYBRID AI-CFAR ACTIVE';
      modeSub.textContent = 'ZERO DROPOUT STANDBY';
      cfarTargetStatus.textContent = engine.targetSCR < 8 ? 'Masked / Missed by CFAR' : 'Degraded by False Alarms';
    }

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
});
