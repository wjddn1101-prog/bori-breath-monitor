/**
 * 보리 호흡 분석기 v6 — ROI Tile Fusion Analysis
 *
 * v5 → v6 핵심 변경:
 *   1. Optical Flow 점 추적 → ROI 타일 기반 밝기 분석
 *      - 카메라 흔들림에 강건: 흔들려도 ROI 평균 밝기는 거의 불변
 *      - 실제 호흡 = 표면 각도 변화 = 반사광 변화 = 밝기 주기적 변동
 *   2. 글로벌 모션 보상: 전체 프레임 이동량 추정 → ROI 위치 보정
 *   3. R/G/B 3채널 독립 추적 → 주기성 최강 채널 자동 선택
 *   4. 레퍼런스 영역 차분: ROI 외부 밝기 변화(조명 변동) 차감
 *   5. 다중 타일 coherence + 로컬 모션 융합으로 저조도 안정성 보강
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
    this._tileCols = 4;
    this._tileRows = 3;
    this._tileSignals = [];
    this._tileProfiles = [];
    this._tileWeights = [];
    this._tileCoherence = 0;
    this._activeTileCount = 0;

    // === 글로벌 모션 보상 ===
    this._prevGray = null;
    this._prevGlobalPts = null;
    this._roiOffsetX = 0;    // 카메라 이동 누적 보정값
    this._roiOffsetY = 0;
    this._gyroRateBeta = 0;  // 자이로 앞뒤 각속도 (deg/s) → Y축 보정
    this._gyroRateGamma = 0; // 자이로 좌우 각속도 (deg/s) → X축 보정

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
    this.debugInfo = { acBpm: null, fftBpm: null, peakBpm: null, channel: 'g', coherence: 0, activeTiles: 0 };

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
      adj.maxBpm = Math.max(base.maxBpm, 50); // 소형견 저조도 대응
    } else if (b < 60) {
      // 플래시 최소 밝기(아이폰 torch 최소) 구간 — 신호 약화 보상
      adj.smoothW = Math.max(base.smoothW, 9);
      adj.windowSec = Math.max(base.windowSec, 30);
      adj.minCycles = Math.max(base.minCycles, 3);
      adj.motionThreshold = base.motionThreshold * 1.4;
      adj.acThreshold = Math.max(base.acThreshold, 0.15);
      adj.maxBpm = Math.max(base.maxBpm, 55); // 소형견 빠른 호흡 포함
    } else if (b < 80) {
      adj.smoothW = Math.max(base.smoothW, 7);
      adj.windowSec = Math.max(base.windowSec, 25);
      adj.motionThreshold = base.motionThreshold * 1.2;
      adj.maxBpm = Math.max(base.maxBpm, 55);
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
    this._tileSignals = [];
    this._tileProfiles = [];
    this._tileWeights = [];
    this._tileCoherence = 0;
    this._activeTileCount = 0;
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
    this.debugInfo = { acBpm: null, fftBpm: null, peakBpm: null, channel: 'g', coherence: 0, activeTiles: 0 };
    this._motionResetTime = 0;   // 마지막 신호 리셋 시각 (ms)
    this._isModerateShake = false; // 현재 중간 흔들림 여부

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

  sampleFrameBrightness(video) {
    if (!video || !video.videoWidth || !video.videoHeight) return null;

    var vw = video.videoWidth, vh = video.videoHeight;
    var scale = Math.min(1, 160 / vw);
    var cw = Math.max(1, Math.round(vw * scale));
    var ch = Math.max(1, Math.round(vh * scale));

    this.canvas.width = cw;
    this.canvas.height = ch;
    this.ctx.drawImage(video, 0, 0, cw, ch);

    var imgData = this.ctx.getImageData(0, 0, cw, ch).data;
    var sum = 0;
    var count = 0;
    for (var i = 0; i < imgData.length; i += 4) {
      sum += (imgData[i] + imgData[i + 1] + imgData[i + 2]) / 3;
      count++;
    }
    return count > 0 ? sum / count : null;
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
        // 방향성 각속도 저장 (ROI 오프셋 보정에 사용)
        this._gyroRateBeta  = r.beta  || 0;
        this._gyroRateGamma = r.gamma || 0;
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

    // 저역 통과: fc = 1.3Hz → 소형견 빠른 호흡 대역까지 포함
    var rcLp = 1.0 / (2 * Math.PI * 1.3);
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

    if (this._tileCoherence > 0) {
      if (this._tileCoherence < 0.2) q -= 18;
      else if (this._tileCoherence < 0.35) q -= 10;
      else if (this._tileCoherence < 0.5) q -= 4;
    }
    if (this._activeTileCount > 0) {
      if (this._activeTileCount < 2) q -= 10;
      else if (this._activeTileCount < 3) q -= 4;
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

  _estimateTileMotion(profile, tileIdx) {
    var prev = this._tileProfiles[tileIdx];
    this._tileProfiles[tileIdx] = profile.slice();
    if (!prev || prev.length !== profile.length) return 0;

    var cur = profile.slice();
    var prv = prev.slice();
    var curMean = 0, prvMean = 0;
    for (var i = 0; i < cur.length; i++) {
      curMean += cur[i];
      prvMean += prv[i];
    }
    curMean /= cur.length;
    prvMean /= prv.length;

    var curMax = 0.0001, prvMax = 0.0001;
    for (var i = 0; i < cur.length; i++) {
      cur[i] -= curMean;
      prv[i] -= prvMean;
      curMax = Math.max(curMax, Math.abs(cur[i]));
      prvMax = Math.max(prvMax, Math.abs(prv[i]));
    }
    for (var i = 0; i < cur.length; i++) {
      cur[i] /= curMax;
      prv[i] /= prvMax;
    }

    var shifts = [-2, -1, 0, 1, 2];
    var scores = [];
    var bestIdx = 0;
    var bestScore = -1;

    for (var si = 0; si < shifts.length; si++) {
      var shift = shifts[si];
      var sum = 0, sumA = 0, sumB = 0;
      for (var i = 0; i < cur.length; i++) {
        var j = i + shift;
        if (j < 0 || j >= prv.length) continue;
        sum += cur[i] * prv[j];
        sumA += cur[i] * cur[i];
        sumB += prv[j] * prv[j];
      }
      var score = (sumA > 0.0001 && sumB > 0.0001) ? (sum / Math.sqrt(sumA * sumB)) : -1;
      scores.push(score);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = si;
      }
    }

    if (bestScore < 0.2) return 0;

    var bestShift = shifts[bestIdx];
    if (bestIdx > 0 && bestIdx < scores.length - 1) {
      var y0 = scores[bestIdx - 1];
      var y1 = scores[bestIdx];
      var y2 = scores[bestIdx + 1];
      var denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 0.0001) {
        bestShift += 0.5 * (y0 - y2) / denom;
      }
    }

    return bestShift;
  }

  _correlateSignals(a, b) {
    var len = Math.min(a.length, b.length, 90);
    if (len < 20) return 0;

    var meanA = 0, meanB = 0;
    for (var i = 0; i < len; i++) {
      meanA += a[a.length - len + i];
      meanB += b[b.length - len + i];
    }
    meanA /= len;
    meanB /= len;

    var sum = 0, sumA = 0, sumB = 0;
    for (var i = 0; i < len; i++) {
      var va = a[a.length - len + i] - meanA;
      var vb = b[b.length - len + i] - meanB;
      sum += va * vb;
      sumA += va * va;
      sumB += vb * vb;
    }
    if (sumA < 0.0001 || sumB < 0.0001) return 0;
    return sum / Math.sqrt(sumA * sumB);
  }

  _updateTileFusionWeights(tiles) {
    var weights = new Array(tiles.length);
    var refIdx = -1;
    var bestSeed = 0;

    for (var i = 0; i < tiles.length; i++) {
      var hist = this._tileSignals[i] || [];
      var recent = hist.slice(-90);
      var energy = recent.length >= 24 ? this._scoreROISignal(recent) : 0;
      tiles[i].energy = energy;
      var seed = energy * (0.35 + tiles[i].texture * 0.65);
      if (seed > bestSeed) {
        bestSeed = seed;
        refIdx = i;
      }
    }

    var maxWeight = 0;
    var coherenceSum = 0;
    var coherenceCount = 0;

    if (refIdx >= 0 && bestSeed >= 0.0005) {
      var refHist = this._tileSignals[refIdx] || [];
      for (var i = 0; i < tiles.length; i++) {
        var corr = (i === refIdx) ? 1 : this._correlateSignals(refHist, this._tileSignals[i] || []);
        if (corr > 0) {
          coherenceSum += corr;
          coherenceCount++;
        }
        var weight = tiles[i].energy * Math.max(0, corr - 0.1) * (0.25 + tiles[i].texture * 0.75);
        if (weight < bestSeed * 0.08) weight = 0;
        weights[i] = weight;
        if (weight > maxWeight) maxWeight = weight;
      }
      this._tileCoherence = coherenceCount > 0 ? (coherenceSum / coherenceCount) : 0;
    } else {
      this._tileCoherence = 0;
      for (var i = 0; i < tiles.length; i++) {
        var localWeight = tiles[i].texture * 0.6 +
          Math.min(0.8, Math.abs(tiles[i].brightness) * 0.04) +
          Math.min(0.6, Math.abs(tiles[i].motion) * 0.1);
        weights[i] = localWeight;
        if (localWeight > maxWeight) maxWeight = localWeight;
      }
    }

    var activeCount = 0;
    if (maxWeight > 0) {
      for (var i = 0; i < weights.length; i++) {
        if (weights[i] >= maxWeight * 0.35) activeCount++;
      }
    }
    if (activeCount === 0 && weights.length > 0) {
      var fallbackIdx = refIdx >= 0 ? refIdx : 0;
      for (var i = 1; i < tiles.length; i++) {
        if (tiles[i].texture > tiles[fallbackIdx].texture) fallbackIdx = i;
      }
      weights[fallbackIdx] = 1;
      maxWeight = Math.max(maxWeight, 1);
      activeCount = 1;
    }

    this._tileWeights = weights;
    this._activeTileCount = activeCount;
    this.debugInfo.coherence = Math.round(this._tileCoherence * 100) / 100;
    this.debugInfo.activeTiles = activeCount;
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
    var tileCols = this._tileCols;
    var tileRows = this._tileRows;
    var tileCount = tileCols * tileRows;
    var profileBins = 8;
    var tiles = new Array(tileCount);
    for (var ti = 0; ti < tileCount; ti++) {
      tiles[ti] = {
        sumR: 0, sumG: 0, sumB: 0, sumGray: 0, sumGray2: 0, count: 0,
        profile: new Array(profileBins).fill(0),
        profileCounts: new Array(profileBins).fill(0),
        brightness: 0, motion: 0, fused: 0, texture: 0,
        meanR: 0, meanG: 0, meanB: 0
      };
    }
    var sampleStep = this.isLowLight ? 1 : 2;

    // ROI 내 픽셀 평균
    for (var y = ry; y < ry + rh; y += sampleStep) {
      var relY = (y - ry) / Math.max(1, rh);
      var tileRow = Math.min(tileRows - 1, Math.floor(relY * tileRows));
      var localY = relY * tileRows - tileRow;
      var profileIdx = Math.min(profileBins - 1, Math.max(0, Math.floor(localY * profileBins)));
      for (var x = rx; x < rx + rw; x += sampleStep) {
        var idx = (y * cw + x) * 4;
        var relX = (x - rx) / Math.max(1, rw);
        var tileCol = Math.min(tileCols - 1, Math.floor(relX * tileCols));
        var tile = tiles[tileRow * tileCols + tileCol];
        var gray = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        sumR += data[idx];
        sumG += data[idx + 1];
        sumB += data[idx + 2];
        count++;
        tile.sumR += data[idx];
        tile.sumG += data[idx + 1];
        tile.sumB += data[idx + 2];
        tile.sumGray += gray;
        tile.sumGray2 += gray * gray;
        tile.count++;
        tile.profile[profileIdx] += gray;
        tile.profileCounts[profileIdx]++;
      }
    }

    if (count === 0) return null;

    var meanR = sumR / count;
    var meanG = sumG / count;
    var meanB = sumB / count;

    // 레퍼런스 영역 (ROI 바로 위 또는 아래 — 조명 변동 차감용)
    var refMeanR = 0;
    var refMeanG = 0;
    var refMeanB = 0;
    var refCount = 0;
    var refY = ry - rh;  // ROI 바로 위
    if (refY < 0) refY = ry + rh; // 위가 없으면 아래
    var refYEnd = Math.min(ch, refY + Math.max(1, Math.round(rh * 0.5)));
    refY = Math.max(0, refY);

    for (var y = refY; y < refYEnd; y += sampleStep) {
      for (var x = rx; x < rx + rw; x += sampleStep) {
        var idx = (y * cw + x) * 4;
        refMeanR += data[idx];
        refMeanG += data[idx + 1];
        refMeanB += data[idx + 2];
        refCount++;
      }
    }
    refMeanR = refCount > 0 ? refMeanR / refCount : meanR;
    refMeanG = refCount > 0 ? refMeanG / refCount : meanG;
    refMeanB = refCount > 0 ? refMeanB / refCount : meanB;

    var refBase = this._bestChannel === 'r' ? refMeanR : this._bestChannel === 'b' ? refMeanB : refMeanG;
    for (var ti = 0; ti < tileCount; ti++) {
      var tile = tiles[ti];
      if (tile.count <= 0) continue;
      tile.meanR = tile.sumR / tile.count;
      tile.meanG = tile.sumG / tile.count;
      tile.meanB = tile.sumB / tile.count;
      var meanGray = tile.sumGray / tile.count;
      var variance = Math.max(0, tile.sumGray2 / tile.count - meanGray * meanGray);
      tile.texture = Math.min(1, Math.sqrt(variance) / 28);
      for (var bi = 0; bi < profileBins; bi++) {
        tile.profile[bi] = tile.profileCounts[bi] > 0 ? (tile.profile[bi] / tile.profileCounts[bi]) : meanGray;
      }
      tile.motion = this._estimateTileMotion(tile.profile, ti);
      var tileBase = this._bestChannel === 'r' ? tile.meanR : this._bestChannel === 'b' ? tile.meanB : tile.meanG;
      tile.brightness = tileBase - refBase;
      var motionWeight = tile.texture < 0.08 ? 0 :
        Math.min(this.isLowLight ? 0.55 : 0.4, 0.1 + tile.texture * 0.45 + (this.isLowLight ? 0.1 : 0));
      var motionResp = tile.motion * (2.5 + tile.texture * 5.5);
      tile.fused = tile.brightness * (1 - motionWeight) + motionResp * motionWeight;
      if (!this._tileSignals[ti]) this._tileSignals[ti] = [];
      this._tileSignals[ti].push(tile.fused);
      if (this._tileSignals[ti].length > 180) this._tileSignals[ti].shift();
    }

    if (!this._tileWeights.length || this._totalFrameCount % 6 === 0) {
      this._updateTileFusionWeights(tiles);
    }

    var weightedR = 0, weightedG = 0, weightedB = 0, weightedFused = 0, weightedMotion = 0;
    var weightSum = 0;
    var fallbackIdx = 0;
    for (var ti = 1; ti < tileCount; ti++) {
      if (tiles[ti].texture + Math.abs(tiles[ti].fused) * 0.02 > tiles[fallbackIdx].texture + Math.abs(tiles[fallbackIdx].fused) * 0.02) {
        fallbackIdx = ti;
      }
    }
    for (var ti = 0; ti < tileCount; ti++) {
      var tile = tiles[ti];
      var w = this._tileWeights[ti] || 0;
      if (w <= 0 || tile.count <= 0) continue;
      weightSum += w;
      weightedR += tile.meanR * w;
      weightedG += tile.meanG * w;
      weightedB += tile.meanB * w;
      weightedFused += tile.fused * w;
      weightedMotion += tile.motion * w;
    }
    if (weightSum <= 0) {
      var fallback = tiles[fallbackIdx];
      weightSum = 1;
      weightedR = fallback.meanR;
      weightedG = fallback.meanG;
      weightedB = fallback.meanB;
      weightedFused = fallback.fused;
      weightedMotion = fallback.motion;
    }

    // UI 시각화용: ROI 영역에 밝기 변화 격자 표시
    this._updateVisualization(rx, ry, rw, rh, cw, ch);

    return {
      r: weightedR / weightSum,
      g: weightedG / weightSum,
      b: weightedB / weightSum,
      refR: refMeanR,
      ref: refMeanG,
      refB: refMeanB,
      fused: weightedFused / weightSum,
      motion: weightedMotion / weightSum,
      coherence: this._tileCoherence,
      activeTiles: this._activeTileCount,
      brightness: (meanR + meanG + meanB) / 3
    };
  }

  // UI용 시각화 점 생성 (ROI 격자) + 신호값 노출
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
    // 최근 신호 상태 계산 (drawTrackingPoints에서 동적 시각화용)
    var recent = this._signalBuf.slice(-20);
    if (recent.length > 2) {
      var maxAbs = 0.0001;
      for (var i = 0; i < recent.length; i++) { var a = Math.abs(recent[i]); if (a > maxAbs) maxAbs = a; }
      this._vizSignalNorm = recent[recent.length - 1] / maxAbs; // -1 ~ +1
      this._vizSignalAmplitude = maxAbs;
      // 상승/하강 방향
      this._vizSignalRising = recent[recent.length - 1] > recent[recent.length - 3];
    } else {
      this._vizSignalNorm = 0;
      this._vizSignalAmplitude = 0;
      this._vizSignalRising = false;
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

    // 모션 게이트 — 3단계: 강한 흔들림(신호 리셋), 중간 흔들림(프레임 skip), 정상
    var strongShake = (this._fusedMotion > 10 || (!this._fusedMotion && this._gyroShakeLevel > 10));
    var moderateShake = !strongShake && (this._fusedMotion > 4 || this._gyroShakeLevel > 5);

    if (strongShake) {
      this._motionFrames++;
      this._isModerateShake = false;
      if (this._motionFrames > 15) {
        // 매우 강한 흔들림 지속 → 신호 리셋
        this._signalBuf = [];
        this.timestamps = [];
        this._chR = []; this._chG = []; this._chB = [];
        this._tileSignals = [];
        this._tileProfiles = [];
        this._tileWeights = [];
        this._tileCoherence = 0;
        this._activeTileCount = 0;
        this._motionFrames = 0;
        this._bpfInitialized = false;
        this._motionResetTime = now;  // 리셋 시각 기록
        if (this._prevGlobalPts) { this._prevGlobalPts.delete(); this._prevGlobalPts = null; }
      }
      if (this._prevGray) this._prevGray.delete();
      this._prevGray = currGray.clone();
      currMat.delete(); currGray.delete();
      return this.lastValidBpm;
    } else if (moderateShake) {
      // 중간 흔들림 — 이 프레임만 신호 수집 skip (리셋 없이)
      this._isModerateShake = true;
      this._motionFrames = Math.max(0, this._motionFrames - 1);
      if (this._prevGray) this._prevGray.delete();
      this._prevGray = currGray.clone();
      currMat.delete(); currGray.delete();
      return this.lastValidBpm;
    }
    this._isModerateShake = false;
    this._motionFrames = 0;

    // 글로벌 모션 추정 (카메라 흔들림) + 자이로 방향성 융합
    var globalMotion = this._estimateGlobalMotion(currGray);
    // 자이로 각속도(deg/s) → 픽셀 이동량 변환 (가중치 0.25로 보수적 적용)
    var gyroDx = this._gyroRateGamma * dt * (cw / 90.0) * 0.25;
    var gyroDy = this._gyroRateBeta  * dt * (ch / 90.0) * 0.25;
    this._roiOffsetX += globalMotion.dx + gyroDx;
    this._roiOffsetY += globalMotion.dy + gyroDy;

    // 보정값이 너무 커지면 리셋 (장기 드리프트 방지)
    if (Math.abs(this._roiOffsetX) > cw * 0.3 || Math.abs(this._roiOffsetY) > ch * 0.3) {
      this._roiOffsetX = 0;
      this._roiOffsetY = 0;
    }

    // ROI 평균 밝기 추출
    var intensity = this._extractROIMeanIntensity(imgData, cw, ch);
    // 저조도 신호 증폭 — 밝기 60 미만 시 최대 2배 게인 적용
    if (intensity && this._frameBrightness < 60) {
      var gain = 1.0 + (60 - this._frameBrightness) / 60 * 1.0;
      gain = Math.min(2.0, gain);
      intensity.r *= gain;
      intensity.g *= gain;
      intensity.b *= gain;
    }

    // 이전 프레임 저장 (글로벌 모션용)
    if (this._prevGray) this._prevGray.delete();
    this._prevGray = currGray.clone();
    currMat.delete(); currGray.delete();

    if (!intensity) return this.lastValidBpm;

    // === 채널별 밝기 버퍼에 추가 ===
    var correctedR = intensity.r - (typeof intensity.refR === 'number' ? intensity.refR : intensity.r);
    var correctedG = intensity.g - intensity.ref;
    var correctedB = intensity.b - (typeof intensity.refB === 'number' ? intensity.refB : intensity.b);
    this._chR.push(correctedR);
    this._chG.push(correctedG);
    this._chB.push(correctedB);

    // 60프레임마다 최적 채널 선택
    if (this._totalFrameCount % 60 === 0) {
      this._selectBestChannel();
    }

    // 선택된 채널의 값을 주 신호로 사용
    var rawValue;
    if (this._bestChannel === 'r') rawValue = correctedR;
    else if (this._bestChannel === 'b') rawValue = correctedB;
    else rawValue = correctedG;
    if (typeof intensity.fused === 'number' && isFinite(intensity.fused)) {
      rawValue = this.isLowLight ? intensity.fused : (intensity.fused * 0.75 + rawValue * 0.25);
    }

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
    if (bpm !== null && this._tileCoherence < 0.16 && this._activeTileCount < 2) {
      bpm = null;
    }

    // Phase 3: TF.js 분류기로 노이즈 신호 억제
    if (bpm !== null && this._classifier && this._classifier.isReady && this.smoothedSignal.length > 50) {
      var mlConf = this._classifier.predict(this.smoothedSignal);
      var mlThreshold = this._tileCoherence < 0.28 ? 0.42 : 0.35;
      if (mlConf < mlThreshold) {
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
        return s.correct === true && Math.abs((s.lightLevel || 80) - lightLevel) <= 25;
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
