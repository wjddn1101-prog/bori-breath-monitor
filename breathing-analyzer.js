/**
 * 보리 호흡 분석기 v5 — Enhanced SRR (Sleeping Respiratory Rate)
 *
 * v4 → v5 개선사항:
 *   1. FFT 주파수 분석 + 3중 교차 검증 (자기상관 + FFT + 피크)
 *   2. 가속도계 + 자이로 상보 필터 융합 모션 보정
 *   3. R/G/B 다중 채널 독립 분석 + 프레임 밝기 기반 자동 채널 선택
 *   4. 칼만 필터 BPM 안정화
 *   5. 적응형 밴드패스 필터 (0.1~1.5Hz)
 *   6. Web Worker 비동기 분석 (메인 스레드 프레임 드랍 방지)
 *
 * SRR 기준: 가슴/배가 한 번 올라갔다 내려오면 = 1회 호흡
 * 정상 수면 호흡: 15~30회/분, 40회 이상 = 위험
 */
class BreathingAnalyzer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.roi = null;
    this.sensitivity = 'medium';
    this.isAnalyzing = false;
    this.startTime = null;

    // === 다중 채널 시그널 버퍼 ===
    this._bufR = [];
    this._bufG = [];
    this._bufB = [];
    this.timestamps = [];
    this._activeChannel = 'g';       // 자동 선택됨
    this._channelSelectTime = 0;     // 마지막 채널 선택 시각
    this._frameBrightness = 128;     // 프레임 평균 밝기 (조도 대용)

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
    this._fusedMotion = 0;           // 상보 필터 융합값
    this._motionHandler = null;

    // === 적응형 밴드패스 필터 (채널별) ===
    this._hpf = { r: { prevX: 0, prevY: 0 }, g: { prevX: 0, prevY: 0 }, b: { prevX: 0, prevY: 0 } };
    this._lpf = { r: 0, g: 0, b: 0 };
    this._bpfInitialized = false;

    // === 칼만 필터 ===
    this._kalman = { x: 0, p: 100, q: 0.5, r: 4, initialized: false };

    // === 저조도 최적화 ===
    this.signalQuality = 0;          // 0~100 신호 품질
    this.isLowLight = false;         // 저조도 모드 활성 여부
    this._noiseFloor = 0;            // 추정 노이즈 수준
    this._noiseDiffs = [];           // 노이즈 추정용 프레임간 차이
    this._validFrameCount = 0;       // 유효 프레임 수 (모션 제외)
    this._totalFrameCount = 0;       // 전체 프레임 수

    // === Web Worker ===
    this._worker = null;
    this._workerBusy = false;
    this._workerResult = null;
    this._lastWorkerPost = 0;
    this._initWorker();

    // 분석 스로틀 (Worker 미사용 폴백)
    this._lastAnalysisTime = 0;
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

    // === 저조도 적응: 프레임 밝기 기반 자동 보정 ===
    var b = this._frameBrightness;
    if (b >= 80) {
      this.isLowLight = false;
      return base;
    }

    // 저조도 모드 활성
    this.isLowLight = true;
    var adj = {};
    for (var k in base) adj[k] = base[k];

    if (b < 30) {
      // 매우 어두움: 공격적 노이즈 보정
      adj.smoothW = Math.max(base.smoothW, 15);          // 스무딩 대폭 강화
      adj.windowSec = Math.max(base.windowSec, 45);      // 긴 윈도우 (더 많은 데이터)
      adj.minCycles = Math.max(base.minCycles, 5);        // 최소 사이클 상향
      adj.motionThreshold = base.motionThreshold * 1.8;   // 노이즈성 모션 오탐 방지
      adj.acThreshold = Math.max(base.acThreshold, 0.20); // 자기상관 기준 상향
    } else if (b < 60) {
      // 어두움: 중간 보정
      adj.smoothW = Math.max(base.smoothW, 11);
      adj.windowSec = Math.max(base.windowSec, 35);
      adj.minCycles = Math.max(base.minCycles, 4);
      adj.motionThreshold = base.motionThreshold * 1.4;
      adj.acThreshold = Math.max(base.acThreshold, 0.18);
    } else {
      // 약간 어두움: 미세 보정
      adj.smoothW = Math.max(base.smoothW, 9);
      adj.windowSec = Math.max(base.windowSec, 32);
      adj.motionThreshold = base.motionThreshold * 1.2;
    }

    // 칼만 필터 노이즈 가중치도 조정 (저조도일수록 측정값 불신)
    if (b < 40) {
      this._kalman.r = 8;   // 측정 노이즈 크게 → 더 보수적
      this._kalman.q = 0.3; // 프로세스 노이즈 작게 → 더 부드럽게
    } else if (b < 80) {
      this._kalman.r = 6;
      this._kalman.q = 0.4;
    }

    return adj;
  }

  setROI(roi) { this.roi = roi; }
  setSensitivity(s) { this.sensitivity = s; }

  start() {
    this._bufR = [];
    this._bufG = [];
    this._bufB = [];
    this.timestamps = [];
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
    this._activeChannel = 'g';
    this._channelSelectTime = 0;
    this._workerResult = null;
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

    this._startMotionSensors();
  }

  stop() {
    this.isAnalyzing = false;
    this._stopMotionSensors();
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
      this._worker.onerror = () => {
        this._worker = null;  // Worker 실패 시 메인 스레드 폴백
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

    // iOS 13+ 권한 요청
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
      // 자이로스코프: 회전 각속도 (deg/s)
      var r = event.rotationRate;
      if (r) {
        var gyroMag = Math.sqrt((r.alpha || 0) ** 2 + (r.beta || 0) ** 2 + (r.gamma || 0) ** 2);
        this._gyroShakeLevel = this._gyroShakeLevel * 0.7 + gyroMag * 0.3;
      }

      // 가속도계: 선형 가속도 (중력 제외)
      var a = event.acceleration;
      if (a) {
        var accelMag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
        this._accelShakeLevel = this._accelShakeLevel * 0.7 + accelMag * 0.3;
      }

      // 상보 필터 융합: 자이로 60% + 가속도 40%
      // 자이로는 빠른 회전(손목 떨림)에 강하고, 가속도는 병진 움직임에 강함
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
  // 고역 통과 (0.1Hz) + 저역 통과 (1.5Hz) 캐스케이드
  _bandpassFilter(value, channel, dt) {
    if (dt <= 0 || dt > 1) dt = 0.033;

    var hpState = this._hpf[channel];

    // 고역 통과: fc = 0.1Hz → 느린 조명 드리프트 제거
    var rcHp = 1.0 / (2 * Math.PI * 0.1);
    var alphaHp = rcHp / (rcHp + dt);
    var hpOut = alphaHp * (hpState.prevY + value - hpState.prevX);
    hpState.prevX = value;
    hpState.prevY = hpOut;

    // 저역 통과: fc = 1.5Hz → 손떨림/노이즈 제거
    var rcLp = 1.0 / (2 * Math.PI * 1.5);
    var alphaLp = dt / (rcLp + dt);
    this._lpf[channel] += alphaLp * (hpOut - this._lpf[channel]);

    return this._lpf[channel];
  }

  // ========== 다중 채널 자동 선택 ==========
  // 프레임 밝기(조도 대용) + 채널별 SNR로 최적 채널 결정
  _autoSelectChannel(now) {
    // 3초마다 재평가
    if (now - this._channelSelectTime < 3000) return;
    this._channelSelectTime = now;

    var minLen = 60;  // 최소 2초 분량
    if (this._bufR.length < minLen) return;

    var recent = minLen;
    var channels = {
      r: this._bufR.slice(-recent),
      g: this._bufG.slice(-recent),
      b: this._bufB.slice(-recent)
    };

    var bestChannel = 'g';
    var bestScore = -1;

    for (var ch in channels) {
      var buf = channels[ch];
      // 디트렌드 후 분산 계산 = 신호 에너지 (SNR 대용)
      var n = buf.length;
      var sx = 0, sy = 0, sxy = 0, sx2 = 0;
      for (var i = 0; i < n; i++) { sx += i; sy += buf[i]; sxy += i * buf[i]; sx2 += i * i; }
      var denom = n * sx2 - sx * sx;
      var slope = Math.abs(denom) > 1e-10 ? (n * sxy - sx * sy) / denom : 0;
      var intercept = (sy - slope * sx) / n;

      var variance = 0;
      for (var i = 0; i < n; i++) {
        var d = buf[i] - (slope * i + intercept);
        variance += d * d;
      }
      variance /= n;

      // 조명 환경 가중치 (프레임 밝기 기반 = 조도센서 대체)
      var weight = 1.0;
      if (this._frameBrightness < 60) {
        // 어두운 환경: 카메라가 게인을 올림 → R채널 SNR 우수
        if (ch === 'r') weight = 1.4;
        else if (ch === 'g') weight = 1.0;
        else weight = 0.7;
      } else if (this._frameBrightness < 150) {
        // 실내 보통 조명: G채널 최적 (베이어 필터 2x 픽셀)
        if (ch === 'g') weight = 1.3;
        else if (ch === 'r') weight = 1.0;
        else weight = 0.8;
      } else {
        // 밝은 환경: G채널 여전히 우수, 포화 시 B 고려
        if (ch === 'g') weight = 1.2;
        else if (ch === 'b') weight = 1.1;
        else weight = 1.0;
      }

      var score = variance * weight;
      if (score > bestScore) {
        bestScore = score;
        bestChannel = ch;
      }
    }

    this._activeChannel = bestChannel;
    this.debugInfo.channel = bestChannel;
  }

  // ========== 칼만 필터 ==========
  _kalmanUpdate(measurement) {
    var k = this._kalman;
    if (!k.initialized) {
      k.x = measurement;
      k.p = 10;
      k.initialized = true;
      return measurement;
    }
    // 예측 단계
    var p = k.p + k.q;
    // 업데이트 단계
    var gain = p / (p + k.r);
    k.x = k.x + gain * (measurement - k.x);
    k.p = (1 - gain) * p;
    return Math.round(k.x);
  }

  // ========== 신호 품질 계산 (0~100) ==========
  _updateSignalQuality() {
    var q = 100;

    // 1. 밝기 페널티 (저조도)
    var b = this._frameBrightness;
    if (b < 20) q -= 45;
    else if (b < 40) q -= 30;
    else if (b < 60) q -= 15;
    else if (b < 80) q -= 5;

    // 2. 모션 안정성
    if (this._fusedMotion > 4) q -= 25;
    else if (this._fusedMotion > 2) q -= 15;
    else if (this._fusedMotion > 1) q -= 5;

    // 3. 노이즈 대비 신호 강도
    if (this._noiseFloor > 0.001 && this._bufG.length > 30) {
      var activeBuf = this._activeChannel === 'r' ? this._bufR : this._activeChannel === 'b' ? this._bufB : this._bufG;
      var recent = activeBuf.slice(-30);
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

    // 4. 유효 프레임 비율 (모션 제외)
    if (this._totalFrameCount > 30) {
      var validRatio = this._validFrameCount / this._totalFrameCount;
      if (validRatio < 0.5) q -= 20;
      else if (validRatio < 0.7) q -= 10;
    }

    // 5. 분석 성공 여부
    if (this.nullCount > 60) q -= 15;
    else if (this.nullCount > 30) q -= 8;

    this.signalQuality = Math.max(0, Math.min(100, q));
  }

  // ========== 매 프레임: 데이터 수집 + 분석 ==========
  analyzeFrame(video) {
    if (!this.isAnalyzing || !this.roi) return this.lastValidBpm;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return this.lastValidBpm;

    var now = Date.now();

    // 프레임 캡처 (성능 축소)
    var scale = Math.min(1, 240 / vw);
    var cw = Math.round(vw * scale), ch = Math.round(vh * scale);
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.ctx.drawImage(video, 0, 0, cw, ch);

    // ROI 픽셀 추출
    var rx = Math.max(0, Math.round(this.roi.x * cw));
    var ry = Math.max(0, Math.round(this.roi.y * ch));
    var rw = Math.max(1, Math.min(Math.round(this.roi.w * cw), cw - rx));
    var rh = Math.max(1, Math.min(Math.round(this.roi.h * ch), ch - ry));
    var data = this.ctx.getImageData(rx, ry, rw, rh).data;
    var pixelCount = data.length / 4;

    // === R/G/B 채널별 평균 밝기 추출 ===
    var totalR = 0, totalG = 0, totalB = 0;
    for (var i = 0; i < data.length; i += 4) {
      totalR += data[i];
      totalG += data[i + 1];
      totalB += data[i + 2];
    }
    var avgR = totalR / pixelCount;
    var avgG = totalG / pixelCount;
    var avgB = totalB / pixelCount;

    // 프레임 전체 밝기 (조도센서 대체)
    this._frameBrightness = avgR * 0.299 + avgG * 0.587 + avgB * 0.114;
    var brightness = avgR * 0.15 + avgG * 0.7 + avgB * 0.15; // 호환용

    // === 4단계 모션 게이트 (가속도계 융합 추가) ===
    var params = this.getParams();
    var isShaking = false;

    // 1단계: 상보 필터 융합 모션 (자이로+가속도)
    if (this._fusedMotion > 5) isShaking = true;

    // 2단계: 자이로 단독 (융합 불가 시 폴백)
    if (!isShaking && this._gyroShakeLevel > 5) isShaking = true;

    // 3단계: 광학 흐름
    if (this._prevFrameData && this._prevFrameData.length === data.length) {
      var pixelShift = 0;
      var sampleStep = Math.max(4, Math.floor(data.length / 400)) * 4;
      var sampleCount = 0;
      for (var fi = 0; fi < data.length && fi < this._prevFrameData.length; fi += sampleStep) {
        pixelShift += Math.abs(data[fi] - this._prevFrameData[fi]);
        pixelShift += Math.abs(data[fi + 1] - this._prevFrameData[fi + 1]);
        sampleCount++;
      }
      if (sampleCount > 0) {
        pixelShift /= (sampleCount * 2);
        if (pixelShift > 3) isShaking = true;
      }
    }
    this._prevFrameData = new Uint8ClampedArray(data);

    // 4단계: 밝기 변화율
    if (this._prevBrightness !== null) {
      var change = Math.abs(brightness - this._prevBrightness) / (this._prevBrightness + 0.001);
      if (change > params.motionThreshold) isShaking = true;
    }

    this._totalFrameCount++;
    if (isShaking) {
      this._motionFrames++;
      this._prevBrightness = brightness;
      if (this._motionFrames > 10) {
        this._bufR = []; this._bufG = []; this._bufB = [];
        this.timestamps = [];
        this._motionFrames = 0;
        this._bpfInitialized = false;
      }
      return this.lastValidBpm;
    }
    this._motionFrames = 0;
    this._prevBrightness = brightness;

    // === 적응형 밴드패스 필터 (채널별 독립) ===
    var dt = this.timestamps.length > 0 ? (now - this.timestamps[this.timestamps.length - 1]) / 1000 : 0.033;

    if (!this._bpfInitialized) {
      this._hpf = {
        r: { prevX: avgR, prevY: 0 },
        g: { prevX: avgG, prevY: 0 },
        b: { prevX: avgB, prevY: 0 }
      };
      this._lpf = { r: 0, g: 0, b: 0 };
      this._bpfInitialized = true;
    }

    var filtR = this._bandpassFilter(avgR, 'r', dt);
    var filtG = this._bandpassFilter(avgG, 'g', dt);
    var filtB = this._bandpassFilter(avgB, 'b', dt);

    this._bufR.push(filtR);
    this._bufG.push(filtG);
    this._bufB.push(filtB);
    this.timestamps.push(now);
    this._totalFrameCount++;
    this._validFrameCount++;

    // 노이즈 추정: 활성 채널의 프레임간 차이 분산 추적
    var activeFilt = this._activeChannel === 'r' ? filtR : this._activeChannel === 'b' ? filtB : filtG;
    if (this._bufG.length > 1) {
      var prevBuf = this._activeChannel === 'r' ? this._bufR : this._activeChannel === 'b' ? this._bufB : this._bufG;
      var diff = activeFilt - prevBuf[prevBuf.length - 2];
      this._noiseDiffs.push(diff * diff);
      if (this._noiseDiffs.length > 90) this._noiseDiffs.shift();
      if (this._noiseDiffs.length > 10) {
        var nSum = 0;
        for (var ni = 0; ni < this._noiseDiffs.length; ni++) nSum += this._noiseDiffs[ni];
        this._noiseFloor = Math.sqrt(nSum / this._noiseDiffs.length);
      }
    }

    // 신호 품질 계산 (0~100)
    this._updateSignalQuality();

    // 버퍼 최대 90초분 유지
    while (this.timestamps.length > 0 && now - this.timestamps[0] > 90000) {
      this._bufR.shift(); this._bufG.shift(); this._bufB.shift();
      this.timestamps.shift();
    }

    // 최소 데이터: 저조도에서는 더 많은 데이터 필요
    var minSec = this.isLowLight ? 8 : 5;
    var minFrames = this.isLowLight ? 60 : 40;
    if (now - this.timestamps[0] < minSec * 1000 || this.timestamps.length < minFrames) {
      return this.lastValidBpm;
    }

    // === 자동 채널 선택 (3초 간격) ===
    this._autoSelectChannel(now);

    // === 분석 실행 (Worker 또는 메인 스레드) ===
    var activeBuffer = this._activeChannel === 'r' ? this._bufR :
                       this._activeChannel === 'b' ? this._bufB : this._bufG;

    // Worker 사용: 300ms 간격으로 비동기 분석
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
        this._worker.postMessage({ signal: sig, timestamps: ts, params: params, fps: sig.length / ((ts[ts.length - 1] - ts[0]) / 1000) });
      }
    }

    // Worker 결과 수신 시 처리
    if (this._workerResult) {
      var wr = this._workerResult;
      this._workerResult = null;
      return this._processAnalysisResult(wr);
    }

    // Worker 없거나 아직 응답 안 왔으면 — 메인 스레드 폴백 (500ms 간격)
    if (!this._worker && now - this._lastAnalysisTime > 500) {
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

  // BPM 결과 → 칼만 필터 → 반환
  _processResult(bpm) {
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

  // ========== 메인 스레드 분석 (Worker 폴백) ==========
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

    // 1. 디트렌드
    var detrended = this._detrend(sig);

    // 2. 스무딩
    var smoothed = this._smooth(detrended, params.smoothW);

    // 3. 정규화
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

    // 4. 자기상관
    var minLag = Math.max(2, Math.round(fps * 60 / params.maxBpm));
    var maxLag = Math.min(Math.floor(norm.length / 2), Math.round(fps * 60 / params.minBpm));
    var acResult = this._autocorrelation(norm, minLag, maxLag);

    // 5. FFT
    var fftResult = this._fftAnalysis(norm, fps, params);

    // 6. 피크 카운팅
    var peakIndices = this._findPeaks(norm, fps, params);
    this.peaks = [];
    for (var i = 0; i < peakIndices.length; i++) this.peaks.push(peakIndices[i] + startIdx);
    var peakBpm = this._bpmFromPeaks(peakIndices, ts, params);

    // BPM 추출
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

    // 7. 3중 교차 검증
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

    // 최소 사이클 수 확인
    for (var i = 0; i < candidates.length; i++) {
      var expectedCycles = duration / (60 / candidates[i].bpm);
      if (expectedCycles < params.minCycles) candidates[i].conf *= 0.5;
    }

    // 2개 이상 일치 (±20%) 찾기
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

    // 일치 없음 — 최고 신뢰도 후보
    candidates.sort(function(a, b) { return (b.conf * b.weight) - (a.conf * a.weight); });
    this.confidence = candidates[0].conf;
    return candidates[0].bpm;
  }

  // ========== FFT 주파수 분석 ==========
  _fftAnalysis(norm, fps, params) {
    // 2의 거듭제곱 제로패딩
    var n = 1;
    while (n < norm.length) n <<= 1;

    var re = new Array(n);
    var im = new Array(n);
    for (var i = 0; i < n; i++) {
      re[i] = i < norm.length ? norm[i] : 0;
      im[i] = 0;
    }

    this._fft(re, im, n);

    // 파워 스펙트럼에서 호흡 주파수 대역 피크 찾기
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

    // 이차 보간으로 주파수 정밀도 향상
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

  // Radix-2 FFT (in-place)
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

  // ========== 기존 메서드 (유지) ==========
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
}

window.BreathingAnalyzer = BreathingAnalyzer;
