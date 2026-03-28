/**
 * 보리 호흡 분석기 v6 — ROI Mean Intensity Analysis
 *
 * v5 → v6 핵심 변경:
 *   1. Optical Flow 점 추적 → ROI 평균 밝기(Green채널) 분석
 *      - 카메라 흔들림에 강건: 흔들려도 ROI 평균 밝기는 거의 불변
 *      - 실제 호흡 = 표면 각도 변화 = 반사광 변화 = 밝기 주기적 변동
 *   2. 글로벌 모션 보상: 전체 프레임 이동량 추정 → ROI 위치 보정
 *   3. R/G/B 3채널 독립 추적 → 주기성 최강 채널 자동 선택
 *   4. 레퍼런스 영역 차분: ROI 외부 밝기 변화(조명 변동) 차감
 *
 * 유지: FFT + 자기상관 + 피크카운팅 3중 교차 검증, 칼만 필터, Web Worker, 밴드패스
 */
class BreathingAnalyzer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.roi = null;
    this.sensitivity = 'medium';
    this.isAnalyzing = false;
    this.startTime = null;

    // === 신호 버퍼 (ROI 평균 밝기 기반) ===
    this._signalBuf = [];
    this.timestamps = [];
    this._frameBrightness = 128;

    // === RGB 채널별 밝기 버퍼 ===
    this._chR = [];
    this._chG = [];
    this._chB = [];
    this._bestChannel = 'g';  // 자동 선택될 최적 채널

    // === 글로벌 모션 보상 ===
    this._prevGray = null;
    this._prevGlobalPts = null;
    this._roiOffsetX = 0;    // 카메라 이동 누적 보정값
    this._roiOffsetY = 0;

    // UI 시각화용 (호환성 유지)
    this.trackedPoints = [];

    // 결과
    this.lastValidBpm = null;
    this.confidence = 0;
    this.smoothedSignal = [];
    this.peaks = [];
    this._windowStartIdx = 0;
    this.nullCount = 0;

    // 분석 방법별 BPM (UI 디버그용)
    this.debugInfo = { acBpm: null, fftBpm: null, peakBpm: null, channel: 'g' };

    // === 모션 게이트 ===
    this._prevBrightness = null;
    this._motionFrames = 0;
    this._prevFrameData = null;

    // 자이로 + 가속도계 융합
    this._gyroShakeLevel = 0;
    this._accelShakeLevel = 0;
    this._fusedMotion = 0;
    this._motionHandler = null;

    // === 적응형 밴드패스 필터 (채널별) ===
    this._hpf = { prevX: 0, prevY: 0 };
    this._lpf = 0;
    this._bpfInitialized = false;

    // === 칼만 필터 ===
    this._kalman = { x: 0, p: 100, q: 0.5, r: 4, initialized: false };

    // === 저조도 최적화 ===
    this.signalQuality = 0;
    this.isLowLight = false;
    this._noiseFloor = 0;
    this._noiseDiffs = [];
    this._validFrameCount = 0;
    this._totalFrameCount = 0;

    // === Web Worker ===
    this._worker = null;
    this._workerBusy = false;
    this._workerResult = null;
    this._lastWorkerPost = 0;
    this._initWorker();

    this._lastAnalysisTime = 0;

    // === Phase 1: 스마트 ROI 자동 탐지 ===
    this._roiUserSet = false;
    this._roiScanActive = false;
    this._roiScanStart = null;
    this._roiScanDuration = 5000;
    this._candidateROIs = [];
    this._candidateSigs = [];
    this.onRoiFound = null;  // 콜백: function(roi)

    // === Phase 2: 적응 학습 ===
    this._mlDataKey = 'bori_ml_data';

    // === Phase 3: TF.js 분류기 ===
    this._classifier = null;
    this._mlSuppressCount = 0;
  }

  // ========== 감도 파라미터 (저조도 적응형) ==========
  getParams() {
    var p = {
      low:       { windowSec: 45, smoothW: 11, minCycles: 5, acThreshold: 0.30, motionThreshold: 0.08, minBpm: 6, maxBpm: 40 },
      medium:    { windowSec: 30, smoothW: 7,  minCycles: 4, acThreshold: 0.25, motionThreshold: 0.06, minBpm: 6, maxBpm: 55 },
      high:      { windowSec: 20, smoothW: 5,  minCycles: 3, acThreshold: 0.18, motionThreshold: 0.05, minBpm: 6, maxBpm: 65 },
      very_high: { windowSec: 15, smoothW: 3,  minCycles: 2, acThreshold: 0.12, motionThreshold: 0.04, minBpm: 4, maxBpm: 80 },
      ultra:     { windowSec: 10, smoothW: 2,  minCycles: 2, acThreshold: 0.08, motionThreshold: 0.03, minBpm: 4, maxBpm: 100 },
    };
    var base = p[this.sensitivity] || p.medium;

    var b = this._frameBrightness;
    if (b >= 80) {
      this.isLowLight = false;
      return base;
    }

    this.isLowLight = true;
    var adj = {};
    for (var k in base) adj[k] = base[k];

    if (b < 30) {
      adj.smoothW = Math.max(base.smoothW, 15);
      adj.windowSec = Math.max(base.windowSec, 45);
      adj.minCycles = Math.max(base.minCycles, 5);
      adj.motionThreshold = base.motionThreshold * 1.8;
      adj.acThreshold = Math.max(base.acThreshold, 0.20);
    } else if (b < 60) {
      adj.smoothW = Math.max(base.smoothW, 11);
      adj.windowSec = Math.max(base.windowSec, 35);
      adj.minCycles = Math.max(base.minCycles, 4);
      adj.motionThreshold = base.motionThreshold * 1.4;
      adj.acThreshold = Math.max(base.acThreshold, 0.18);
    } else {
      adj.smoothW = Math.max(base.smoothW, 9);
      adj.windowSec = Math.max(base.windowSec, 32);
      adj.motionThreshold = base.motionThreshold * 1.2;
    }

    if (b < 40) {
      this._kalman.r = 8;
      this._kalman.q = 0.3;
    } else if (b < 80) {
      this._kalman.r = 6;
      this._kalman.q = 0.4;
    }

    return adj;
  }

  setROI(roi, userSet) { this.roi = roi; this._roiUserSet = !!userSet; }
  setSensitivity(s) { this.sensitivity = s; }

  start() {
    this._signalBuf = [];
    this.timestamps = [];
    this._chR = [];
    this._chG = [];
    this._chB = [];
    this._bestChannel = 'g';
    this.smoothedSignal = [];
    this.peaks = [];
    this.startTime = Date.now();
    this.isAnalyzing = true;
    this.lastValidBpm = null;
    this.confidence = 0;
    this.nullCount = 0;
    this._prevBrightness = null;
    this._motionFrames = 0;
    this._prevFrameData = null;
    this._bpfInitialized = false;
    this._kalman = { x: 0, p: 100, q: 0.5, r: 4, initialized: false };
    this._workerResult = null;

    // 글로벌 모션 보상 초기화
    if (this._prevGray) { this._prevGray.delete(); this._prevGray = null; }
    if (this._prevGlobalPts) { this._prevGlobalPts.delete(); this._prevGlobalPts = null; }
    this._roiOffsetX = 0;
    this._roiOffsetY = 0;

    this.trackedPoints = [];
    this.signalQuality = 0;
    this.isLowLight = false;
    this._noiseFloor = 0;
    this._noiseDiffs = [];
    this._validFrameCount = 0;
    this._totalFrameCount = 0;
    this._workerBusy = false;
    this._lastWorkerPost = 0;
    this._lastAnalysisTime = 0;
    this.debugInfo = { acBpm: null, fftBpm: null, peakBpm: null, channel: 'g' };

    // ROI 스캔 초기화 (사용자가 수동으로 ROI를 지정하지 않은 경우만)
    this._roiScanActive = !this._roiUserSet;
    this._roiScanStart = null;
    this._candidateSigs = [];
    if (this._roiScanActive) this._initCandidateROIs();
    this._mlSuppressCount = 0;

    this._startMotionSensors();
  }

  stop() {
    this.isAnalyzing = false;
    this._stopMotionSensors();
    if (this._prevGray) { this._prevGray.delete(); this._prevGray = null; }
    if (this._prevGlobalPts) { this._prevGlobalPts.delete(); this._prevGlobalPts = null; }
  }

  getElapsedSeconds() {
    return this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
  }

  // ========== Web Worker 초기화 ==========
  _initWorker() {
    try {
      this._worker = new Worker('analysis-worker.js');
      this._worker.onmessage = (e) => {
        this._workerBusy = false;
        this._workerResult = e.data;
      };
      this._worker.onerror = (err) => {
        console.warn('Worker error:', err);
        this._workerBusy = false;
        this._worker = null;
      };
      this._worker.onmessageerror = () => {
        this._workerBusy = false;
      };
    } catch (e) {
      this._worker = null;
    }
  }

  // ========== 가속도계 + 자이로 상보 필터 융합 ==========
  _startMotionSensors() {
    this._gyroShakeLevel = 0;
    this._accelShakeLevel = 0;
    this._fusedMotion = 0;

    if (!window.DeviceMotionEvent) return;

    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then((state) => {
        if (state === 'granted') this._bindMotionHandler();
      }).catch(() => {});
    } else {
      this._bindMotionHandler();
    }
  }

  _bindMotionHandler() {
    this._motionHandler = (event) => {
      var r = event.rotationRate;
      if (r) {
        var gyroMag = Math.sqrt((r.alpha || 0) ** 2 + (r.beta || 0) ** 2 + (r.gamma || 0) ** 2);
        this._gyroShakeLevel = this._gyroShakeLevel * 0.7 + gyroMag * 0.3;
      }

      var a = event.acceleration;
      if (a) {
        var accelMag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
        this._accelShakeLevel = this._accelShakeLevel * 0.7 + accelMag * 0.3;
      }

      this._fusedMotion = this._gyroShakeLevel * 0.6 + this._accelShakeLevel * 0.4 * 10;
    };
    window.addEventListener('devicemotion', this._motionHandler);
  }

  _stopMotionSensors() {
    if (this._motionHandler) {
      window.removeEventListener('devicemotion', this._motionHandler);
      this._motionHandler = null;
    }
  }

  // ========== 적응형 밴드패스 필터 ==========
  _bandpassFilter(value, dt) {
    if (dt <= 0 || dt > 1) dt = 0.033;

    var hpState = this._hpf;

    // 고역 통과: fc = 0.1Hz → 느린 드리프트 제거
    var rcHp = 1.0 / (2 * Math.PI * 0.1);
    var alphaHp = rcHp / (rcHp + dt);
    var hpOut = alphaHp * (hpState.prevY + value - hpState.prevX);
    hpState.prevX = value;
    hpState.prevY = hpOut;

    // 저역 통과: fc = 1.0Hz → 호흡 대역만 통과 (v5의 1.5Hz에서 하향)
    var rcLp = 1.0 / (2 * Math.PI * 1.0);
    var alphaLp = dt / (rcLp + dt);
    this._lpf += alphaLp * (hpOut - this._lpf);

    return this._lpf;
  }

  // ========== 칼만 필터 (적응형) ==========
  _kalmanUpdate(measurement) {
    var k = this._kalman;
    if (!k.initialized) {
      k.x = measurement;
      k.p = 10;
      k.initialized = true;
      return measurement;
    }

    var deviation = Math.abs(measurement - k.x);
    var adaptiveQ = k.q;
    if (deviation > 8) {
      adaptiveQ = k.q * 10;
    } else if (deviation > 4) {
      adaptiveQ = k.q * 4;
    }

    var p = k.p + adaptiveQ;
    var gain = p / (p + k.r);
    k.x = k.x + gain * (measurement - k.x);
    k.p = (1 - gain) * p;
    return Math.round(k.x);
  }

  // ========== 신호 품질 계산 (0~100) ==========
  _updateSignalQuality() {
    var q = 100;

    var b = this._frameBrightness;
    if (b < 20) q -= 45;
    else if (b < 40) q -= 30;
    else if (b < 60) q -= 15;
    else if (b < 80) q -= 5;

    if (this._fusedMotion > 4) q -= 25;
    else if (this._fusedMotion > 2) q -= 15;
    else if (this._fusedMotion > 1) q -= 5;

    if (this._noiseFloor > 0.001 && this._signalBuf.length > 30) {
      var recent = this._signalBuf.slice(-30);
      var sigVar = 0, sigMean = 0;
      for (var i = 0; i < recent.length; i++) sigMean += recent[i];
      sigMean /= recent.length;
      for (var i = 0; i < recent.length; i++) sigVar += (recent[i] - sigMean) * (recent[i] - sigMean);
      sigVar = Math.sqrt(sigVar / recent.length);
      var snr = sigVar / (this._noiseFloor + 0.0001);
      if (snr < 1.5) q -= 25;
      else if (snr < 3) q -= 15;
      else if (snr < 5) q -= 5;
    }

    if (this._totalFrameCount > 30) {
      var validRatio = this._validFrameCount / this._totalFrameCount;
      if (validRatio < 0.5) q -= 20;
      else if (validRatio < 0.7) q -= 10;
    }

    if (this.nullCount > 60) q -= 15;
    else if (this.nullCount > 30) q -= 8;

    this.signalQuality = Math.max(0, Math.min(100, q));
  }

  // ========== 글로벌 모션 추정 (카메라 흔들림 보상) ==========
  _estimateGlobalMotion(currGray) {
    if (!this._prevGray) return { dx: 0, dy: 0 };

    // 전체 프레임에서 특징점 추출 (글로벌 모션용)
    if (!this._prevGlobalPts) {
      var p0 = new cv.Mat();
      cv.goodFeaturesToTrack(this._prevGray, p0, 50, 0.05, 20);
      if (p0.rows < 5) { p0.delete(); return { dx: 0, dy: 0 }; }
      this._prevGlobalPts = p0;
    }

    // Optical Flow로 전체 프레임 이동 추정
    var p1 = new cv.Mat();
    var status = new cv.Mat();
    var err = new cv.Mat();
    var winSize = new cv.Size(21, 21);
    var criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 10, 0.03);

    cv.calcOpticalFlowPyrLK(this._prevGray, currGray, this._prevGlobalPts, p1, status, err, winSize, 2, criteria);

    // 유효한 점들의 이동량 중앙값 = 글로벌 모션 (카메라 흔들림)
    var dxList = [], dyList = [];
    var d0 = this._prevGlobalPts.data32F;
    var d1 = p1.data32F;
    var stat = status.data;

    for (var i = 0; i < status.rows; i++) {
      if (stat[i] === 1) {
        dxList.push(d1[i*2] - d0[i*2]);
        dyList.push(d1[i*2+1] - d0[i*2+1]);
      }
    }

    // 다음 프레임용: 현재 프레임 점으로 교체
    this._prevGlobalPts.delete();
    this._prevGlobalPts = null;  // 매 프레임 재초기화 (드리프트 방지)

    p1.delete(); status.delete(); err.delete();

    if (dxList.length < 3) return { dx: 0, dy: 0 };

    // 중앙값 추출
    dxList.sort(function(a,b) { return a - b; });
    dyList.sort(function(a,b) { return a - b; });
    var mid = Math.floor(dxList.length / 2);

    return { dx: dxList[mid], dy: dyList[mid] };
  }

  // ========== ROI 영역 평균 밝기 추출 (R, G, B 채널 별) ==========
  _extractROIMeanIntensity(imgData, cw, ch) {
    // ROI를 글로벌 모션만큼 보정
    var rx = Math.round(this.roi.x * cw - this._roiOffsetX);
    var ry = Math.round(this.roi.y * ch - this._roiOffsetY);
    var rw = Math.round(this.roi.w * cw);
    var rh = Math.round(this.roi.h * ch);

    // 경계 클램핑
    rx = Math.max(0, Math.min(rx, cw - rw));
    ry = Math.max(0, Math.min(ry, ch - rh));
    rw = Math.max(1, Math.min(rw, cw - rx));
    rh = Math.max(1, Math.min(rh, ch - ry));

    var data = imgData.data;
    var sumR = 0, sumG = 0, sumB = 0;
    var count = 0;

    // ROI 내 픽셀 평균
    for (var y = ry; y < ry + rh; y++) {
      for (var x = rx; x < rx + rw; x++) {
        var idx = (y * cw + x) * 4;
        sumR += data[idx];
        sumG += data[idx + 1];
        sumB += data[idx + 2];
        count++;
      }
    }

    if (count === 0) return null;

    var meanR = sumR / count;
    var meanG = sumG / count;
    var meanB = sumB / count;

    // 레퍼런스 영역 (ROI 바로 위 또는 아래 — 조명 변동 차감용)
    var refMeanG = 0;
    var refCount = 0;
    var refY = ry - rh;  // ROI 바로 위
    if (refY < 0) refY = ry + rh; // 위가 없으면 아래
    var refYEnd = Math.min(ch, refY + Math.max(1, Math.round(rh * 0.5)));
    refY = Math.max(0, refY);

    for (var y = refY; y < refYEnd; y++) {
      for (var x = rx; x < rx + rw; x++) {
        var idx = (y * cw + x) * 4;
        refMeanG += data[idx + 1];
        refCount++;
      }
    }
    refMeanG = refCount > 0 ? refMeanG / refCount : meanG;

    // UI 시각화용: ROI 영역에 밝기 변화 격자 표시
    this._updateVisualization(rx, ry, rw, rh, cw, ch);

    return {
      r: meanR,
      g: meanG,
      b: meanB,
      ref: refMeanG,
      brightness: (meanR + meanG + meanB) / 3
    };
  }

  // UI용 시각화 점 생성 (ROI 격자)
  _updateVisualization(rx, ry, rw, rh, cw, ch) {
    this.trackedPoints = [];
    var cols = 6, rows = 4;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var px = (rx + rw * (c + 0.5) / cols) / cw;
        var py = (ry + rh * (r + 0.5) / rows) / ch;
        this.trackedPoints.push({ x0: px, y0: py, x1: px, y1: py });
      }
    }
  }

  // ========== 채널 자동 선택 (주기성 최강 채널) ==========
  _selectBestChannel() {
    if (this._chR.length < 60) return;  // 2초 이상 축적 후 판단

    var channels = { r: this._chR, g: this._chG, b: this._chB };
    var bestScore = -1;
    var best = 'g';

    for (var ch in channels) {
      var buf = channels[ch];
      var recent = buf.slice(-60);
      // 분산 (주기적 변동이 클수록 호흡 신호 강도↑)
      var mean = 0;
      for (var i = 0; i < recent.length; i++) mean += recent[i];
      mean /= recent.length;
      var variance = 0;
      for (var i = 0; i < recent.length; i++) variance += (recent[i] - mean) ** 2;
      variance /= recent.length;

      // 제로크로싱 카운트 (적절한 주기성이면 호흡 범위 내)
      var crossings = 0;
      for (var i = 1; i < recent.length; i++) {
        if ((recent[i] - mean) * (recent[i-1] - mean) < 0) crossings++;
      }
      // 호흡 범위 (6~55 bpm → 0.1~0.92 Hz → 30fps에서 3~55 크로싱/60프레임)
      var crossScore = (crossings >= 2 && crossings <= 60) ? 1 : 0.3;

      var score = variance * crossScore;
      if (score > bestScore) { bestScore = score; best = ch; }
    }

    this._bestChannel = best;
    this.debugInfo.channel = best;
  }

  // ========== 매 프레임: ROI 평균 밝기 수집 + 분석 ==========
  analyzeFrame(video) {
    if (!this.isAnalyzing || !this.roi) return this.lastValidBpm;
    if (!window.openCvReady || typeof cv === 'undefined') return this.lastValidBpm;

    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return this.lastValidBpm;

    var now = Date.now();
    var dt = this.timestamps.length > 0 ? (now - this.timestamps[this.timestamps.length - 1]) / 1000 : 0.033;

    this._totalFrameCount++;

    // 프레임 캡처 (성능 축소)
    var scale = Math.min(1, 320 / vw);
    var cw = Math.round(vw * scale), ch = Math.round(vh * scale);
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.ctx.drawImage(video, 0, 0, cw, ch);

    var imgData = this.ctx.getImageData(0, 0, cw, ch);

    // === Phase 1: ROI 스캔 모드 — 9개 후보 영역 밝기 수집 ===
    if (this._roiScanActive) {
      if (!this._roiScanStart) this._roiScanStart = now;
      for (var ci = 0; ci < this._candidateROIs.length; ci++) {
        this._candidateSigs[ci].push(this._extractROIGreen(imgData, cw, ch, this._candidateROIs[ci]));
      }
      if (now - this._roiScanStart >= this._roiScanDuration) {
        this._finalizeScan();
      }
    }

    // === OpenCV: 그레이스케일 + 글로벌 모션 추정 ===
    var currMat = cv.matFromImageData(imgData);
    var currGray = new cv.Mat();
    cv.cvtColor(currMat, currGray, cv.COLOR_RGBA2GRAY);

    // 프레임 밝기
    var mean = cv.mean(currGray);
    this._frameBrightness = mean[0];

    // 모션 게이트 (심한 흔들림만 차단 — 밝기 분석은 가벼운 떨림에 강건)
    var physicalShake = (this._fusedMotion > 15 || (!this._fusedMotion && this._gyroShakeLevel > 15));
    if (physicalShake) {
      this._motionFrames++;
      if (this._motionFrames > 20) {
        // 매우 강한 흔들림 → 신호 리셋
        this._signalBuf = [];
        this.timestamps = [];
        this._chR = []; this._chG = []; this._chB = [];
        this._motionFrames = 0;
        this._bpfInitialized = false;
        if (this._prevGlobalPts) { this._prevGlobalPts.delete(); this._prevGlobalPts = null; }
      }
      if (this._prevGray) this._prevGray.delete();
      this._prevGray = currGray.clone();
      currMat.delete(); currGray.delete();
      return this.lastValidBpm;
    }
    this._motionFrames = 0;

    // 글로벌 모션 추정 (카메라 흔들림)
    var globalMotion = this._estimateGlobalMotion(currGray);
    this._roiOffsetX += globalMotion.dx;
    this._roiOffsetY += globalMotion.dy;

    // 보정값이 너무 커지면 리셋 (장기 드리프트 방지)
    if (Math.abs(this._roiOffsetX) > cw * 0.3 || Math.abs(this._roiOffsetY) > ch * 0.3) {
      this._roiOffsetX = 0;
      this._roiOffsetY = 0;
    }

    // ROI 평균 밝기 추출
    var intensity = this._extractROIMeanIntensity(imgData, cw, ch);

    // 이전 프레임 저장 (글로벌 모션용)
    if (this._prevGray) this._prevGray.delete();
    this._prevGray = currGray.clone();
    currMat.delete(); currGray.delete();

    if (!intensity) return this.lastValidBpm;

    // === 채널별 밝기 버퍼에 추가 ===
    // 레퍼런스 차분: ROI 밝기 - 레퍼런스 밝기 (조명 변동 제거)
    var correctedG = intensity.g - intensity.ref;
    this._chR.push(intensity.r);
    this._chG.push(correctedG);
    this._chB.push(intensity.b);

    // 60프레임마다 최적 채널 선택
    if (this._totalFrameCount % 60 === 0) {
      this._selectBestChannel();
    }

    // 선택된 채널의 값을 주 신호로 사용
    var rawValue;
    if (this._bestChannel === 'r') rawValue = intensity.r;
    else if (this._bestChannel === 'b') rawValue = intensity.b;
    else rawValue = correctedG;

    // 밴드패스 필터 적용
    if (!this._bpfInitialized) {
      this._hpf = { prevX: rawValue, prevY: 0 };
      this._lpf = 0;
      this._bpfInitialized = true;
    }

    var filteredValue = this._bandpassFilter(rawValue, dt);

    this._signalBuf.push(filteredValue);
    this.timestamps.push(now);
    this._validFrameCount++;

    // 버퍼 관리 (90초 이상 오래된 데이터 제거)
    while (this.timestamps.length > 0 && now - this.timestamps[0] > 90000) {
      this._signalBuf.shift();
      this.timestamps.shift();
      this._chR.shift(); this._chG.shift(); this._chB.shift();
    }

    // === 신호 품질 + 노이즈 추정 ===
    this._updateSignalQuality();

    if (this._signalBuf.length > 1) {
      var diff = filteredValue - this._signalBuf[this._signalBuf.length - 2];
      this._noiseDiffs.push(diff * diff);
      if (this._noiseDiffs.length > 90) this._noiseDiffs.shift();
      if (this._noiseDiffs.length > 10) {
        var nSum = 0;
        for (var ni = 0; ni < this._noiseDiffs.length; ni++) nSum += this._noiseDiffs[ni];
        this._noiseFloor = Math.sqrt(nSum / this._noiseDiffs.length);
      }
    }

    // 최소 데이터 확인
    var params = this.getParams();
    var minSec = this.isLowLight ? 8 : 5;
    var minFrames = this.isLowLight ? 60 : 40;
    if (now - this.timestamps[0] < minSec * 1000 || this.timestamps.length < minFrames) {
      return this.lastValidBpm;
    }

    // === 분석 실행 ===
    var activeBuffer = this._signalBuf;

    // Worker 결과 확인
    if (this._workerResult) {
      var wr = this._workerResult;
      this._workerResult = null;
      this._processAnalysisResult(wr);
    }

    if (this._workerBusy && now - this._lastWorkerPost > 2000) {
      this._workerBusy = false;
    }

    // Worker 비동기 분석
    if (this._worker && !this._workerBusy && now - this._lastWorkerPost > 300) {
      var windowMs = params.windowSec * 1000;
      var startIdx = 0;
      for (var i = this.timestamps.length - 1; i >= 0; i--) {
        if (now - this.timestamps[i] > windowMs) { startIdx = i + 1; break; }
      }
      var sig = activeBuffer.slice(startIdx);
      var ts = this.timestamps.slice(startIdx);
      if (sig.length >= 30) {
        this._workerBusy = true;
        this._lastWorkerPost = now;
        this._workerStartIdx = startIdx;
        try {
          this._worker.postMessage({ signal: sig, timestamps: ts, params: params, fps: sig.length / ((ts[ts.length - 1] - ts[0]) / 1000) });
        } catch (e) {
          this._workerBusy = false;
          this._worker = null;
        }
      }
    }

    // 메인 스레드 분석 (400ms 주기)
    if (now - this._lastAnalysisTime > 400) {
      this._lastAnalysisTime = now;
      var bpm = this._analyzeWindow(activeBuffer);
      return this._processResult(bpm);
    }

    return this.lastValidBpm;
  }

  // Worker 결과 처리
  _processAnalysisResult(wr) {
    if (wr.smoothedSignal) this.smoothedSignal = wr.smoothedSignal;
    if (wr.peaks) {
      this.peaks = [];
      var offset = this._workerStartIdx || 0;
      for (var i = 0; i < wr.peaks.length; i++) this.peaks.push(wr.peaks[i] + offset);
    }
    this.debugInfo.acBpm = wr.acBpm;
    this.debugInfo.fftBpm = wr.fftBpm;
    this.debugInfo.peakBpm = wr.peakBpm;

    if (wr.confidence) this.confidence = wr.confidence;

    return this._processResult(wr.bpm);
  }

  // BPM 결과 → (Phase 3) ML 분류기 체크 → 칼만 필터 → 반환
  _processResult(bpm) {
    // Phase 3: TF.js 분류기로 노이즈 신호 억제
    if (bpm !== null && this._classifier && this._classifier.isReady && this.smoothedSignal.length > 50) {
      var mlConf = this._classifier.predict(this.smoothedSignal);
      if (mlConf < 0.35) {
        this._mlSuppressCount++;
        bpm = null;
      } else {
        this._mlSuppressCount = 0;
      }
    }

    if (bpm !== null) {
      bpm = this._kalmanUpdate(bpm);
      this.lastValidBpm = bpm;
      this.nullCount = 0;
      return bpm;
    } else {
      this.nullCount++;
      if (this.nullCount > 90) this.lastValidBpm = null;
      return this.lastValidBpm;
    }
  }

  // ========== 메인 스레드 분석 ==========
  _analyzeWindow(activeBuffer) {
    var params = this.getParams();
    var now = this.timestamps[this.timestamps.length - 1];
    var windowMs = params.windowSec * 1000;

    var startIdx = 0;
    for (var i = this.timestamps.length - 1; i >= 0; i--) {
      if (now - this.timestamps[i] > windowMs) { startIdx = i + 1; break; }
    }

    var sig = activeBuffer.slice(startIdx);
    var ts = this.timestamps.slice(startIdx);
    if (sig.length < 30) return null;

    var duration = (ts[ts.length - 1] - ts[0]) / 1000;
    if (duration < 3) return null;
    var fps = sig.length / duration;

    var detrended = this._detrend(sig);
    var smoothed = this._smooth(detrended, params.smoothW);

    var maxAbs = 0;
    for (var i = 0; i < smoothed.length; i++) {
      var a = Math.abs(smoothed[i]);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs < 0.0001) return null;
    var norm = new Array(smoothed.length);
    for (var i = 0; i < smoothed.length; i++) norm[i] = smoothed[i] / maxAbs;

    this.smoothedSignal = norm;
    this._windowStartIdx = startIdx;

    var minLag = Math.max(2, Math.round(fps * 60 / params.maxBpm));
    var maxLag = Math.min(Math.floor(norm.length / 2), Math.round(fps * 60 / params.minBpm));
    var acResult = this._autocorrelation(norm, minLag, maxLag);

    var fftResult = this._fftAnalysis(norm, fps, params);

    var peakIndices = this._findPeaks(norm, fps, params);
    this.peaks = [];
    for (var i = 0; i < peakIndices.length; i++) this.peaks.push(peakIndices[i] + startIdx);
    var peakBpm = this._bpmFromPeaks(peakIndices, ts, params);

    var acBpm = null, acConf = 0;
    if (acResult) {
      acBpm = Math.round(60 / (acResult.lag / fps));
      acConf = acResult.confidence;
    }
    var fftBpm = fftResult ? fftResult.bpm : null;
    var fftConf = fftResult ? fftResult.confidence : 0;

    this.debugInfo.acBpm = acBpm;
    this.debugInfo.fftBpm = fftBpm;
    this.debugInfo.peakBpm = peakBpm;

    return this._crossValidate(acBpm, acConf, fftBpm, fftConf, peakBpm, params, duration);
  }

  // ========== 3중 교차 검증 ==========
  _crossValidate(acBpm, acConf, fftBpm, fftConf, peakBpm, params, duration) {
    var candidates = [];
    if (acBpm !== null && acBpm >= params.minBpm && acBpm <= params.maxBpm) {
      candidates.push({ bpm: acBpm, conf: acConf, weight: 3 });
    }
    if (fftBpm !== null && fftBpm >= params.minBpm && fftBpm <= params.maxBpm) {
      candidates.push({ bpm: fftBpm, conf: fftConf, weight: 2 });
    }
    if (peakBpm !== null && peakBpm >= params.minBpm && peakBpm <= params.maxBpm) {
      candidates.push({ bpm: peakBpm, conf: 0.3, weight: 1 });
    }

    if (candidates.length === 0) return null;

    for (var i = 0; i < candidates.length; i++) {
      var expectedCycles = duration / (60 / candidates[i].bpm);
      if (expectedCycles < params.minCycles) candidates[i].conf *= 0.5;
    }

    if (candidates.length >= 2) {
      var bestAgreement = null;
      for (var i = 0; i < candidates.length; i++) {
        for (var j = i + 1; j < candidates.length; j++) {
          var avg = (candidates[i].bpm + candidates[j].bpm) / 2;
          var diff = Math.abs(candidates[i].bpm - candidates[j].bpm) / Math.max(avg, 1);
          if (diff < 0.2) {
            var wTotal = candidates[i].weight + candidates[j].weight;
            var wBpm = Math.round((candidates[i].bpm * candidates[i].weight + candidates[j].bpm * candidates[j].weight) / wTotal);
            var wConf = Math.max(candidates[i].conf, candidates[j].conf);
            var bonus = candidates.length >= 3 ? 1.15 : 1.1;
            var fConf = Math.min(1, wConf * bonus);
            if (!bestAgreement || fConf > bestAgreement.conf) {
              bestAgreement = { bpm: wBpm, conf: fConf };
            }
          }
        }
      }
      if (bestAgreement) {
        this.confidence = bestAgreement.conf;
        return bestAgreement.bpm;
      }
    }

    candidates.sort(function(a, b) { return (b.conf * b.weight) - (a.conf * a.weight); });
    this.confidence = candidates[0].conf;
    return candidates[0].bpm;
  }

  // ========== FFT 주파수 분석 ==========
  _fftAnalysis(norm, fps, params) {
    var n = 1;
    while (n < norm.length) n <<= 1;

    var re = new Array(n);
    var im = new Array(n);
    for (var i = 0; i < n; i++) {
      re[i] = i < norm.length ? norm[i] : 0;
      im[i] = 0;
    }

    this._fft(re, im, n);

    var freqRes = fps / n;
    var minFreq = params.minBpm / 60;
    var maxFreq = params.maxBpm / 60;
    var minBin = Math.max(1, Math.floor(minFreq / freqRes));
    var maxBin = Math.min(n / 2, Math.ceil(maxFreq / freqRes));

    var bestPower = 0, bestBin = 0, totalPower = 0;
    for (var i = minBin; i <= maxBin; i++) {
      var power = re[i] * re[i] + im[i] * im[i];
      totalPower += power;
      if (power > bestPower) { bestPower = power; bestBin = i; }
    }

    if (bestBin === 0 || totalPower < 0.0001) return null;

    var precBin = bestBin;
    if (bestBin > minBin && bestBin < maxBin) {
      var p0 = re[bestBin - 1] * re[bestBin - 1] + im[bestBin - 1] * im[bestBin - 1];
      var p1 = bestPower;
      var p2 = re[bestBin + 1] * re[bestBin + 1] + im[bestBin + 1] * im[bestBin + 1];
      var denom = p0 - 2 * p1 + p2;
      if (Math.abs(denom) > 0.0001) {
        precBin = bestBin + 0.5 * (p0 - p2) / denom;
      }
    }

    var peakFreq = precBin * freqRes;
    var bpm = Math.round(peakFreq * 60);
    var confidence = bestPower / (totalPower + 0.0001);

    if (bpm < params.minBpm || bpm > params.maxBpm) return null;
    return { bpm: bpm, confidence: Math.min(1, confidence * 3) };
  }

  _fft(re, im, n) {
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        var t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (var i = 0; i < n; i += len) {
        var curRe = 1, curIm = 0;
        for (var j = 0; j < len / 2; j++) {
          var uRe = re[i + j], uIm = im[i + j];
          var vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
          var vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + len / 2] = uRe - vRe;
          im[i + j + len / 2] = uIm - vIm;
          var tRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = tRe;
        }
      }
    }
  }

  // ========== 유틸리티 ==========
  _autocorrelation(signal, minLag, maxLag) {
    var n = signal.length;
    if (maxLag >= n / 2 || minLag >= maxLag) return null;

    var mean = 0;
    for (var i = 0; i < n; i++) mean += signal[i];
    mean /= n;

    var centered = new Array(n);
    for (var i = 0; i < n; i++) centered[i] = signal[i] - mean;

    var variance = 0;
    for (var i = 0; i < n; i++) variance += centered[i] * centered[i];
    if (variance < 0.0001) return null;

    var bestLag = 0, bestVal = -1;
    var values = new Array(maxLag - minLag + 1);

    for (var lag = minLag; lag <= maxLag; lag++) {
      var sum = 0;
      for (var j = 0; j < n - lag; j++) sum += centered[j] * centered[j + lag];
      values[lag - minLag] = sum / variance;
    }

    for (var i = 1; i < values.length - 1; i++) {
      if (values[i] > values[i - 1] && values[i] > values[i + 1] && values[i] > bestVal) {
        bestVal = values[i];
        bestLag = minLag + i;
        break;
      }
    }

    if (bestLag === 0 || bestVal < 0.05) return null;
    return { lag: bestLag, confidence: Math.min(1, bestVal) };
  }

  _findPeaks(norm, fps, params) {
    var peaks = [];
    var minDist = Math.max(2, Math.round(fps * 60 / params.maxBpm * 0.7));

    var energy = 0;
    for (var i = 0; i < norm.length; i++) energy += norm[i] * norm[i];
    energy /= norm.length;
    var threshold = Math.max(0.05, Math.sqrt(energy) * 0.3);

    for (var i = 2; i < norm.length - 2; i++) {
      if (norm[i] > norm[i - 1] && norm[i] > norm[i - 2] &&
          norm[i] > norm[i + 1] && norm[i] > norm[i + 2] &&
          norm[i] >= threshold) {
        if (!peaks.length || (i - peaks[peaks.length - 1]) >= minDist) {
          peaks.push(i);
        } else if (norm[i] > norm[peaks[peaks.length - 1]]) {
          peaks[peaks.length - 1] = i;
        }
      }
    }
    return peaks;
  }

  _bpmFromPeaks(peakIndices, ts, params) {
    if (peakIndices.length < 2) return null;

    var intervals = [];
    for (var i = 1; i < peakIndices.length; i++) {
      var dt = ts[peakIndices[i]] - ts[peakIndices[i - 1]];
      if (dt > 0) intervals.push(dt);
    }
    if (intervals.length < 1) return null;

    if (intervals.length >= 3) {
      var sorted = intervals.slice().sort(function(a, b) { return a - b; });
      var median = sorted[Math.floor(sorted.length / 2)];
      var filtered = [];
      for (var i = 0; i < intervals.length; i++) {
        if (intervals[i] > median * 0.5 && intervals[i] < median * 1.5) filtered.push(intervals[i]);
      }
      if (filtered.length >= 1) {
        var avg = 0;
        for (var i = 0; i < filtered.length; i++) avg += filtered[i];
        avg /= filtered.length;
        return Math.round(60000 / avg);
      }
    }

    var totalDur = ts[peakIndices[peakIndices.length - 1]] - ts[peakIndices[0]];
    if (totalDur <= 0) return null;
    return Math.round(60000 / (totalDur / (peakIndices.length - 1)));
  }

  _detrend(sig) {
    var n = sig.length;
    var sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (var i = 0; i < n; i++) { sx += i; sy += sig[i]; sxy += i * sig[i]; sx2 += i * i; }
    var denom = n * sx2 - sx * sx;
    if (Math.abs(denom) < 1e-10) {
      var avg = sy / n;
      var out = new Array(n);
      for (var i = 0; i < n; i++) out[i] = sig[i] - avg;
      return out;
    }
    var slope = (n * sxy - sx * sy) / denom;
    var intercept = (sy - slope * sx) / n;
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = sig[i] - (slope * i + intercept);
    return out;
  }

  _smooth(sig, w) {
    if (w < 2) return sig.slice();
    var half = Math.floor(w / 2);
    var out = new Array(sig.length);
    for (var i = 0; i < sig.length; i++) {
      var sum = 0, c = 0;
      var lo = Math.max(0, i - half);
      var hi = Math.min(sig.length - 1, i + half);
      for (var j = lo; j <= hi; j++) { sum += sig[j]; c++; }
      out[i] = sum / c;
    }
    return out;
  }

  // ========== Phase 1: 스마트 ROI 자동 탐지 ==========

  _initCandidateROIs() {
    this._candidateROIs = [];
    this._candidateSigs = [];
    var sz = 0.28;
    // 3×3 그리드: x, y 시작 위치 (sz 만큼의 크기)
    var pos = [0.05, 0.36, 0.67];
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        this._candidateROIs.push({ x: pos[c], y: pos[r], w: sz, h: sz });
        this._candidateSigs.push([]);
      }
    }
  }

  // 빠른 Green 채널 평균 추출 (2픽셀 간격 샘플링)
  _extractROIGreen(imgData, cw, ch, roi) {
    var rx = Math.max(0, Math.round(roi.x * cw));
    var ry = Math.max(0, Math.round(roi.y * ch));
    var rw = Math.max(1, Math.round(roi.w * cw));
    var rh = Math.max(1, Math.round(roi.h * ch));
    rx = Math.min(rx, cw - rw);
    ry = Math.min(ry, ch - rh);
    var data = imgData.data;
    var sumG = 0, count = 0;
    for (var y = ry; y < ry + rh; y += 2) {
      for (var x = rx; x < rx + rw; x += 2) {
        sumG += data[(y * cw + x) * 4 + 1];
        count++;
      }
    }
    return count > 0 ? sumG / count : 128;
  }

  // 신호에서 호흡 주파수(0.1–1.0Hz) 에너지 계산 → 높을수록 가슴 부위
  _scoreROISignal(sig) {
    if (sig.length < 20) return 0;
    var n = sig.length;
    var mean = 0;
    for (var i = 0; i < n; i++) mean += sig[i];
    mean /= n;

    var hp = { px: sig[0] - mean, py: 0 }, lp = 0;
    var aHp = (1.0 / (2 * Math.PI * 0.1)) / ((1.0 / (2 * Math.PI * 0.1)) + 0.033);
    var aLp = 0.033 / ((1.0 / (2 * Math.PI * 1.0)) + 0.033);
    var filtered = [];
    for (var i = 0; i < n; i++) {
      var v = sig[i] - mean;
      var hpOut = aHp * (hp.py + v - hp.px);
      hp.px = v; hp.py = hpOut;
      lp += aLp * (hpOut - lp);
      filtered.push(lp);
    }

    var fmean = 0;
    for (var i = 0; i < n; i++) fmean += filtered[i];
    fmean /= n;
    var variance = 0;
    for (var i = 0; i < n; i++) variance += (filtered[i] - fmean) * (filtered[i] - fmean);
    return variance / n;
  }

  // 5초 스캔 완료 → 최고 에너지 ROI 선택
  _finalizeScan() {
    this._roiScanActive = false;
    var bestScore = -1;
    var bestIdx = 4;  // 기본: 중앙 셀
    for (var i = 0; i < this._candidateSigs.length; i++) {
      var score = this._scoreROISignal(this._candidateSigs[i]);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    this.roi = this._candidateROIs[bestIdx];
    if (this.onRoiFound) this.onRoiFound(this.roi);
  }

  // ========== Phase 2: 적응 학습 파라미터 로드 ==========

  // 비슷한 조도 환경에서 성공한 감도 설정을 추천
  loadAdaptiveParams(lightLevel) {
    try {
      var stored = JSON.parse(localStorage.getItem(this._mlDataKey) || '{"version":1,"samples":[]}');
      var samples = (stored.samples || []).filter(function(s) {
        return Math.abs((s.lightLevel || 80) - lightLevel) <= 25;
      });
      if (samples.length < 3) return null;
      var sensCount = {};
      samples.forEach(function(s) {
        sensCount[s.sensitivity] = (sensCount[s.sensitivity] || 0) + 1;
      });
      var bestSens = Object.keys(sensCount).reduce(function(a, b) {
        return sensCount[a] >= sensCount[b] ? a : b;
      });
      return { sensitivity: bestSens, sampleCount: samples.length };
    } catch (e) { return null; }
  }
}

window.BreathingAnalyzer = BreathingAnalyzer;
