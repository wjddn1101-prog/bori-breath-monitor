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

    // === 다중 채널 시그널 버퍼 대신 통합 변위 버퍼 ===
    this._signalBuf = [];
    this.timestamps = [];
    this._frameBrightness = 128;     // 프레임 평균 밝기 (조도 대용)

    // === OpenCV Optical Flow (Motion Capture) ===
    this._prevGray = null;
    this._prevPts = null;
    this._cumulativeY = 0;
    this.trackedPoints = [];         // UI 시각화용 가상 마커 좌표들

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

    // === 적응형 밴드패스 필터 ===
    this._hpf = { prevX: 0, prevY: 0 };
    this._lpf = 0;
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
    this._signalBuf = [];
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
    this._workerResult = null;
    
    // OpenAPI 초기화
    if (this._prevGray) { this._prevGray.delete(); this._prevGray = null; }
    if (this._prevPts) { this._prevPts.delete(); this._prevPts = null; }
    this._cumulativeY = 0;
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

    this._startMotionSensors();
  }

  stop() {
    this.isAnalyzing = false;
    this._stopMotionSensors();
    if (this._prevGray) { this._prevGray.delete(); this._prevGray = null; }
    if (this._prevPts) { this._prevPts.delete(); this._prevPts = null; }
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
        this._worker = null;  // Worker 실패 시 메인 스레드 폴백
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
  _bandpassFilter(value, dt) {
    if (dt <= 0 || dt > 1) dt = 0.033;

    var hpState = this._hpf;

    // 고역 통과: fc = 0.1Hz → 느린 드리프트 제거
    var rcHp = 1.0 / (2 * Math.PI * 0.1);
    var alphaHp = rcHp / (rcHp + dt);
    var hpOut = alphaHp * (hpState.prevY + value - hpState.prevX);
    hpState.prevX = value;
    hpState.prevY = hpOut;

    // 저역 통과: fc = 1.5Hz → 손떨림/노이즈 제거
    var rcLp = 1.0 / (2 * Math.PI * 1.5);
    var alphaLp = dt / (rcLp + dt);
    this._lpf += alphaLp * (hpOut - this._lpf);

    return this._lpf;
  }

  // (다중 채널 자동 선택 삭제됨)

  // ========== 칼만 필터 (적응형) ==========
  _kalmanUpdate(measurement) {
    var k = this._kalman;
    if (!k.initialized) {
      k.x = measurement;
      k.p = 10;
      k.initialized = true;
      return measurement;
    }

    // 적응형: 측정값이 현재 추정과 크게 다르면 프로세스 노이즈를 일시 증가
    // → 급격한 호흡 변화에 빠르게 적응
    var deviation = Math.abs(measurement - k.x);
    var adaptiveQ = k.q;
    if (deviation > 8) {
      adaptiveQ = k.q * 10;  // 큰 변화 → 빠르게 추종
    } else if (deviation > 4) {
      adaptiveQ = k.q * 4;
    }

    // 예측 단계
    var p = k.p + adaptiveQ;
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

  // ========== 매 프레임: 데이터 수집 + 분석 (Optical Flow) ==========
  analyzeFrame(video) {
    if (!this.isAnalyzing || !this.roi) return this.lastValidBpm;
    if (!window.openCvReady || typeof cv === 'undefined') return this.lastValidBpm;

    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return this.lastValidBpm;

    var now = Date.now();
    var dt = this.timestamps.length > 0 ? (now - this.timestamps[this.timestamps.length - 1]) / 1000 : 0.033;

    // 프레임 캡처 (성능 축소)
    var scale = Math.min(1, 240 / vw);
    var cw = Math.round(vw * scale), ch = Math.round(vh * scale);
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.ctx.drawImage(video, 0, 0, cw, ch);

    // === OpenCV Optical Flow ===
    // 1. 이미지 데이터 가져오기
    var imgData = this.ctx.getImageData(0, 0, cw, ch);
    var currMat = cv.matFromImageData(imgData);
    var currGray = new cv.Mat();
    cv.cvtColor(currMat, currGray, cv.COLOR_RGBA2GRAY);

    // 프레임 밝기 추출 (모션 게이트용 폴백)
    var mean = cv.mean(currGray);
    this._frameBrightness = mean[0];

    // 모션 게이트 (물리 흔들림)
    // 모바일 환경에서 손떨림으로 인해 끊임없이 추적이 초기화되는 것을 막기 위해 임계값 상향
    var physicalShake = (this._fusedMotion > 12 || (!this._fusedMotion && this._gyroShakeLevel > 12));
    if (physicalShake) {
        this._motionFrames++;
        if (this._motionFrames > 15) {
            // 강한 흔들림 지속 -> 트래킹 초기화
            if (this._prevPts) { this._prevPts.delete(); this._prevPts = null; }
            this._signalBuf = [];
            this.timestamps = [];
            this._motionFrames = 0;
            this._bpfInitialized = false;
        }
        currMat.delete(); currGray.delete();
        return this.lastValidBpm;
    }
    this._motionFrames = 0;

    // 2. 특징점(가상 마커) 초기화
    var needInit = false;
    if (!this._prevGray || !this._prevPts || this.trackedPoints.length < 15) {
        needInit = true;
    }

    if (needInit) {
        if (this._prevPts) { this._prevPts.delete(); this._prevPts = null; }
        
        // ROI 마스크 생성
        var mask = cv.Mat.zeros(ch, cw, cv.CV_8UC1);
        var rx = Math.max(0, Math.round(this.roi.x * cw));
        var ry = Math.max(0, Math.round(this.roi.y * ch));
        var rw = Math.max(1, Math.min(Math.round(this.roi.w * cw), cw - rx));
        var rh = Math.max(1, Math.min(Math.round(this.roi.h * ch), ch - ry));
        var roiRect = new cv.Rect(rx, ry, rw, rh);
        
        // 마스크 영역 255로 칠하기
        var roiView = mask.roi(roiRect);
        roiView.setTo(new cv.Scalar(255));

        // 특징점 찾기 (Shi-Tomasi)
        var p0 = new cv.Mat();
        var maxCorners = 150;     // 특징점 수 증가 (100 -> 150)
        var qualityLevel = 0.01;  // 대비가 낮은 털에서도 잘 잡히도록 민감도 상향 (0.05 -> 0.01)
        var minDistance = 10;     // 점들이 한 곳에 몰리지 않도록 간격 넓힘 (5 -> 10)
        cv.goodFeaturesToTrack(currGray, p0, maxCorners, qualityLevel, minDistance, mask);

        mask.delete();
        roiView.delete();

        if (p0.rows > 0) {
            this._prevPts = p0;
            if (this._prevGray) this._prevGray.delete();
            this._prevGray = currGray.clone();
            
            // UI용 점 초기화 (0.0 ~ 1.0 정규화 좌표)
            this.trackedPoints = [];
            var ptr = p0.data32F;
            for (var i = 0; i < p0.rows; i++) {
                var nx = ptr[i*2] / cw, ny = ptr[i*2+1] / ch;
                this.trackedPoints.push({ x0: nx, y0: ny, x1: nx, y1: ny });
            }
        }
        
        currMat.delete(); currGray.delete();
        return this.lastValidBpm;
    }

    // 3. Optical Flow (Lucas-Kanade)
    var p1 = new cv.Mat();
    var status = new cv.Mat();
    var err = new cv.Mat();
    var winSize = new cv.Size(15, 15);
    var maxLevel = 2;
    var criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 10, 0.03);

    cv.calcOpticalFlowPyrLK(this._prevGray, currGray, this._prevPts, p1, status, err, winSize, maxLevel, criteria);

    // 4. 점 이동량 (Y축 displacement) 계산
    var good_p1 = [];
    var good_p0 = [];
    var dyList = [];
    this.trackedPoints = [];

    var d0 = this._prevPts.data32F;
    var d1 = p1.data32F;
    var stat = status.data;

    for (var i = 0; i < status.rows; i++) {
        if (stat[i] === 1) {
            var x0 = d0[i*2], y0 = d0[i*2+1];
            var x1 = d1[i*2], y1 = d1[i*2+1];
            
            // 지나치게 큰 이동은 노이즈로 간주하고 버림
            var maxMovement = ch * 0.1;
            var dy = y1 - y0;
            if (Math.abs(dy) < maxMovement) {
                good_p1.push(x1, y1);
                good_p0.push(x0, y0);
                dyList.push(dy);
                // UI 시각화용 이전, 현재 좌표 모두 저장 (0.0 ~ 1.0 비율로 정규화)
                this.trackedPoints.push({ x0: x0 / cw, y0: y0 / ch, x1: x1 / cw, y1: y1 / ch });
            }
        }
    }

    // 5. 중앙값(Median) 이동량 추출하여 통합 변위에 누적
    if (dyList.length > 0) {
        dyList.sort(function(a,b) { return a - b; });
        var medianDy = dyList[Math.floor(dyList.length / 2)];
        this._cumulativeY += medianDy;
    }

    // 6. 다음 프레임을 위해 정리
    if (good_p1.length > 0) {
        var p1Arr = new cv.Mat(good_p1.length / 2, 1, cv.CV_32FC2);
        p1Arr.data32F.set(good_p1);
        this._prevPts.delete();
        this._prevPts = p1Arr;
    } else {
        if (this._prevPts) { this._prevPts.delete(); this._prevPts = null; }
    }
    
    this._prevGray.delete();
    this._prevGray = currGray.clone();

    p1.delete(); status.delete(); err.delete(); currMat.delete(); currGray.delete();

    // 7. BPF 적용 및 버퍼 푸시
    if (!this._bpfInitialized) {
        this._hpf = { prevX: this._cumulativeY, prevY: 0 };
        this._lpf = 0;
        this._bpfInitialized = true;
    }

    var filtY = this._bandpassFilter(this._cumulativeY, dt);
    
    this._signalBuf.push(filtY);
    this.timestamps.push(now);
    this._validFrameCount++;
    this._totalFrameCount++;

    // === 신호 버퍼 유지 및 분석 (기존 코드 유지) ===
    this._updateSignalQuality();

    // 노이즈 추정
    if (this._signalBuf.length > 1) {
        var diff = filtY - this._signalBuf[this._signalBuf.length - 2];
        this._noiseDiffs.push(diff * diff);
        if (this._noiseDiffs.length > 90) this._noiseDiffs.shift();
        if (this._noiseDiffs.length > 10) {
            var nSum = 0;
            for (var ni = 0; ni < this._noiseDiffs.length; ni++) nSum += this._noiseDiffs[ni];
            this._noiseFloor = Math.sqrt(nSum / this._noiseDiffs.length);
        }
    }

    while (this.timestamps.length > 0 && now - this.timestamps[0] > 90000) {
        this._signalBuf.shift();
        this.timestamps.shift();
    }

    var params = this.getParams();
    var minSec = this.isLowLight ? 8 : 5;
    var minFrames = this.isLowLight ? 60 : 40;
    if (now - this.timestamps[0] < minSec * 1000 || this.timestamps.length < minFrames) {
        return this.lastValidBpm;
    }

    // === 분석 실행 ===
    var activeBuffer = this._signalBuf;

    // Worker 결과 먼저 확인
    if (this._workerResult) {
        var wr = this._workerResult;
        this._workerResult = null;
        this._processAnalysisResult(wr);
    }

    // Worker 타임아웃
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
