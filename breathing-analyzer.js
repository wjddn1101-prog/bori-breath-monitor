/**
 * 보리 호흡 분석기 v4 — SRR (Sleeping Respiratory Rate)
 *
 * 알고리즘:
 *   1. ROI 평균 밝기 추출 (녹색 채널 70% 가중)
 *   2. 슬라이딩 윈도우 + 선형 디트렌드
 *   3. 이동평균 스무딩 (밴드패스 효과)
 *   4. 자기상관(Autocorrelation)으로 호흡 주기 검출
 *   5. 피크 카운팅으로 교차 검증
 *   6. 모션 게이트: 급격한 밝기 변화 시 프레임 제외
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

    // 시그널 버퍼
    this.rawBuffer = [];
    this.timestamps = [];

    // 결과
    this.lastValidBpm = null;
    this.confidence = 0;
    this.smoothedSignal = [];
    this.peaks = [];
    this._windowStartIdx = 0;
    this.nullCount = 0;

    // 모션 게이트
    this._prevBrightness = null;
    this._motionFrames = 0;

    // [신규] 손떨림 방지 시스템
    this._prevFrameData = null;       // 이전 프레임 ROI 픽셀 (광학 흐름)
    this._gyroShakeLevel = 0;         // 자이로스코프 흔들림 수치
    this._gyroHandler = null;
    this._lpfState = 0;               // 버터워스 로우패스 필터 상태
    this._lpfInitialized = false;
  }

  /**
   * 감도별 파라미터
   * - windowSec: 분석 윈도우 길이 (길수록 안정, 짧으면 반응 빠름)
   * - smoothW: 스무딩 윈도우 (클수록 노이즈 제거, 작으면 민감)
   * - minCycles: 최소 요구 호흡 사이클 수
   * - acThreshold: 자기상관 피크 최소 높이 (낮을수록 관대)
   * - motionThreshold: 모션 감지 임계값 (프레임간 밝기 변화율)
   * - minBpm/maxBpm: BPM 허용 범위
   */
  getParams() {
    var p = {
      low:       { windowSec: 45, smoothW: 11, minCycles: 5, acThreshold: 0.30, motionThreshold: 0.08, minBpm: 6, maxBpm: 40 },
      medium:    { windowSec: 30, smoothW: 7,  minCycles: 4, acThreshold: 0.25, motionThreshold: 0.06, minBpm: 6, maxBpm: 55 },
      high:      { windowSec: 20, smoothW: 5,  minCycles: 3, acThreshold: 0.18, motionThreshold: 0.05, minBpm: 6, maxBpm: 65 },
      very_high: { windowSec: 15, smoothW: 3,  minCycles: 2, acThreshold: 0.12, motionThreshold: 0.04, minBpm: 4, maxBpm: 80 },
      ultra:     { windowSec: 10, smoothW: 2,  minCycles: 2, acThreshold: 0.08, motionThreshold: 0.03, minBpm: 4, maxBpm: 100 },
    };
    return p[this.sensitivity] || p.medium;
  }

  setROI(roi) { this.roi = roi; }
  setSensitivity(s) { this.sensitivity = s; }

  start() {
    this.rawBuffer = [];
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
    this._lpfState = 0;
    this._lpfInitialized = false;

    // [신규] 자이로스코프 손떨림 감지 시작
    this._startGyro();
  }

  stop() {
    this.isAnalyzing = false;
    this._stopGyro();
  }

  // === 자이로스코프 기반 물리적 손떨림 감지 ===
  _startGyro() {
    this._gyroShakeLevel = 0;
    if (window.DeviceMotionEvent) {
      this._gyroHandler = (event) => {
        var r = event.rotationRate;
        if (r) {
          // 초당 회전 각속도 크기 (deg/s) — 손떨림은 보통 5~50 deg/s
          var magnitude = Math.sqrt((r.alpha||0)**2 + (r.beta||0)**2 + (r.gamma||0)**2);
          // 지수 이동평균으로 부드럽게 추적
          this._gyroShakeLevel = this._gyroShakeLevel * 0.7 + magnitude * 0.3;
        }
      };
      window.addEventListener('devicemotion', this._gyroHandler);
    }
  }

  _stopGyro() {
    if (this._gyroHandler) {
      window.removeEventListener('devicemotion', this._gyroHandler);
      this._gyroHandler = null;
    }
  }

  getElapsedSeconds() {
    return this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
  }

  /**
   * 매 프레임 호출 — 비디오에서 ROI 밝기 추출 후 분석
   */
  analyzeFrame(video) {
    if (!this.isAnalyzing || !this.roi) return this.lastValidBpm;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return this.lastValidBpm;

    // 프레임 캡처 (성능을 위해 축소)
    var scale = Math.min(1, 240 / vw);
    var cw = Math.round(vw * scale), ch = Math.round(vh * scale);
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.ctx.drawImage(video, 0, 0, cw, ch);

    // ROI 영역 픽셀 추출
    var rx = Math.max(0, Math.round(this.roi.x * cw));
    var ry = Math.max(0, Math.round(this.roi.y * ch));
    var rw = Math.max(1, Math.min(Math.round(this.roi.w * cw), cw - rx));
    var rh = Math.max(1, Math.min(Math.round(this.roi.h * ch), ch - ry));

    var data = this.ctx.getImageData(rx, ry, rw, rh).data;
    var total = 0;
    var count = data.length / 4;
    for (var i = 0; i < data.length; i += 4) {
      // 녹색 채널 가중치 — 카메라 센서에서 SNR 최적
      total += data[i] * 0.15 + data[i+1] * 0.7 + data[i+2] * 0.15;
    }
    var brightness = total / count;
    var now = Date.now();

    // === 강화된 3단계 모션 게이트 ===
    var params = this.getParams();
    var isShaking = false;

    // 1단계: 자이로스코프 물리 떨림 감지 (5 deg/s 이상 = 손떨림)
    if (this._gyroShakeLevel > 5) {
      isShaking = true;
    }

    // 2단계: 광학 흐름 — ROI 픽셀 이동량 추적
    var currentFrameData = data;
    if (this._prevFrameData && this._prevFrameData.length === data.length) {
      var pixelShift = 0;
      var sampleStep = Math.max(4, Math.floor(data.length / 400)) * 4; // 100개 샘플
      var sampleCount = 0;
      for (var fi = 0; fi < data.length && fi < this._prevFrameData.length; fi += sampleStep) {
        pixelShift += Math.abs(data[fi] - this._prevFrameData[fi]);
        pixelShift += Math.abs(data[fi+1] - this._prevFrameData[fi+1]);
        sampleCount++;
      }
      if (sampleCount > 0) {
        pixelShift /= (sampleCount * 2);
        // 평균 픽셀 변화가 3 이상이면 카메라 움직임 감지
        if (pixelShift > 3) isShaking = true;
      }
    }
    // 현재 프레임 저장 (복사)
    this._prevFrameData = new Uint8ClampedArray(data);

    // 3단계: 밝기 변화율 (기존 방식 유지)
    if (this._prevBrightness !== null) {
      var change = Math.abs(brightness - this._prevBrightness) / (this._prevBrightness + 0.001);
      if (change > params.motionThreshold) isShaking = true;
    }

    if (isShaking) {
      this._motionFrames++;
      this._prevBrightness = brightness;
      if (this._motionFrames > 10) {
        this.rawBuffer = [];
        this.timestamps = [];
        this._motionFrames = 0;
      }
      return this.lastValidBpm;
    }
    this._motionFrames = 0;
    this._prevBrightness = brightness;

    // [신규] 버터워스 로우패스 필터 (1.5Hz 차단 = 90BPM 이상 차단)
    // 손떨림(3~10Hz)을 완벽히 제거하면서 호흡 신호(0.1~1.5Hz)만 통과
    if (!this._lpfInitialized) {
      this._lpfState = brightness;
      this._lpfInitialized = true;
    }
    // 프레임간 시간차 기반 적응형 알파 계산
    var dt = this.timestamps.length > 0 ? (now - this.timestamps[this.timestamps.length - 1]) / 1000 : 0.033;
    var cutoffHz = 1.5; // 차단 주파수: 1.5Hz (= 분당 90회)
    var rc = 1.0 / (2 * Math.PI * cutoffHz);
    var alpha = dt / (rc + dt);
    this._lpfState += alpha * (brightness - this._lpfState);

    // 필터링된 신호를 버퍼에 추가
    this.rawBuffer.push(this._lpfState);
    this.timestamps.push(now);

    // 버퍼 최대 90초분 유지
    while (this.timestamps.length > 0 && now - this.timestamps[0] > 90000) {
      this.rawBuffer.shift();
      this.timestamps.shift();
    }

    // 최소 5초 데이터 필요
    if (now - this.timestamps[0] < 5000 || this.rawBuffer.length < 40) {
      return this.lastValidBpm;
    }

    // 분석 실행
    var bpm = this._analyzeWindow();

    if (bpm !== null) {
      this.lastValidBpm = bpm;
      this.nullCount = 0;
      return bpm;
    } else {
      this.nullCount++;
      if (this.nullCount > 90) {
        this.lastValidBpm = null;
      }
      return this.lastValidBpm;
    }
  }

  /**
   * 슬라이딩 윈도우 분석 — 자기상관 + 피크 카운팅
   */
  _analyzeWindow() {
    var params = this.getParams();
    var now = this.timestamps[this.timestamps.length - 1];
    var windowMs = params.windowSec * 1000;

    // 최근 windowSec 초 데이터 추출
    var startIdx = 0;
    for (var i = this.timestamps.length - 1; i >= 0; i--) {
      if (now - this.timestamps[i] > windowMs) { startIdx = i + 1; break; }
    }

    var sig = this.rawBuffer.slice(startIdx);
    var ts = this.timestamps.slice(startIdx);
    if (sig.length < 30) return null;

    // 실효 fps 계산
    var duration = (ts[ts.length - 1] - ts[0]) / 1000;
    if (duration < 3) return null;
    var fps = sig.length / duration;

    // 1. 선형 트렌드 제거 (조명 변화 보정)
    var detrended = this._detrend(sig);

    // 2. 이동평균 스무딩 (고주파 노이즈 제거)
    var smoothed = this._smooth(detrended, params.smoothW);

    // 3. 정규화 (-1 ~ +1)
    var maxAbs = 0;
    for (var i = 0; i < smoothed.length; i++) {
      var a = Math.abs(smoothed[i]);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs < 0.0001) return null;
    var norm = [];
    for (var i = 0; i < smoothed.length; i++) {
      norm.push(smoothed[i] / maxAbs);
    }

    // UI용 저장
    this.smoothedSignal = norm;
    this._windowStartIdx = startIdx;

    // 4. 자기상관(Autocorrelation)으로 호흡 주기 검출
    // 한 번 오르내림(1회 호흡) = 시그널의 1주기 = 자기상관 첫 번째 피크
    var minLag = Math.max(2, Math.round(fps * 60 / params.maxBpm));
    var maxLag = Math.min(Math.floor(norm.length / 2), Math.round(fps * 60 / params.minBpm));

    var acResult = this._autocorrelation(norm, minLag, maxLag);

    // 5. 피크 카운팅 (교차 검증용)
    var peakIndices = this._findPeaks(norm, fps, params);
    this.peaks = [];
    for (var i = 0; i < peakIndices.length; i++) {
      this.peaks.push(peakIndices[i] + startIdx);
    }
    var peakBpm = this._bpmFromPeaks(peakIndices, ts, params);

    // 6. 결과 결정 — 자기상관 우선, 피크로 검증
    var acBpm = null;
    if (acResult) {
      var period = acResult.lag / fps;
      acBpm = Math.round(60 / period);
      this.confidence = acResult.confidence;
    }

    // 최소 사이클 수 확인
    var minCyclesOk = true;
    if (acBpm !== null) {
      var expectedCycles = duration / (60 / acBpm);
      if (expectedCycles < params.minCycles) minCyclesOk = false;
    }

    // 판정 로직
    if (acBpm !== null && peakBpm !== null) {
      // 둘 다 있으면 — 일치 여부 확인
      var diff = Math.abs(acBpm - peakBpm) / Math.max(acBpm, 1);
      if (diff < 0.25 && minCyclesOk) {
        // 잘 일치 — 자기상관 결과 사용 (더 안정적)
        return this._clampBpm(acBpm, params);
      } else if (acResult && acResult.confidence >= params.acThreshold && minCyclesOk) {
        // 자기상관 신뢰도 높으면 자기상관 우선
        return this._clampBpm(acBpm, params);
      } else {
        // 불일치 — 피크 결과 사용
        return this._clampBpm(peakBpm, params);
      }
    } else if (acBpm !== null && acResult && acResult.confidence >= params.acThreshold && minCyclesOk) {
      return this._clampBpm(acBpm, params);
    } else if (peakBpm !== null) {
      this.confidence = 0.3; // 피크만으로는 신뢰도 낮음
      return this._clampBpm(peakBpm, params);
    }

    return null;
  }

  _clampBpm(bpm, params) {
    if (bpm >= params.minBpm && bpm <= params.maxBpm) return bpm;
    return null;
  }

  /**
   * 자기상관 함수 — 호흡 주기의 반복성을 검출
   * 가슴이 올라갔다 내려오는 1주기가 반복되면 해당 주기 lag에서 피크 발생
   */
  _autocorrelation(signal, minLag, maxLag) {
    var n = signal.length;
    if (maxLag >= n / 2 || minLag >= maxLag) return null;

    // 평균 제거
    var mean = 0;
    for (var i = 0; i < n; i++) mean += signal[i];
    mean /= n;

    var centered = [];
    for (var i = 0; i < n; i++) centered.push(signal[i] - mean);

    // 분산 (lag=0 자기상관)
    var variance = 0;
    for (var i = 0; i < n; i++) variance += centered[i] * centered[i];
    if (variance < 0.0001) return null;

    // 자기상관 계산 + 첫 번째 유의미한 피크 찾기
    var bestLag = 0;
    var bestVal = -1;
    var values = [];

    for (var lag = minLag; lag <= maxLag; lag++) {
      var sum = 0;
      for (var j = 0; j < n - lag; j++) {
        sum += centered[j] * centered[j + lag];
      }
      var acVal = sum / variance;
      values.push(acVal);
    }

    // 피크 찾기 (3포인트 극대점)
    for (var i = 1; i < values.length - 1; i++) {
      if (values[i] > values[i-1] && values[i] > values[i+1] && values[i] > bestVal) {
        bestVal = values[i];
        bestLag = minLag + i;
        break; // 첫 번째 유의미한 피크만 사용 (기본 주기)
      }
    }

    if (bestLag === 0 || bestVal < 0.05) return null;

    return { lag: bestLag, confidence: Math.min(1, bestVal) };
  }

  /**
   * 피크 검출 — 시그널에서 호흡 꼭대기(가슴 최고점) 찾기
   */
  _findPeaks(norm, fps, params) {
    var peaks = [];
    // 최소 피크 간격 (BPM 상한에서 계산)
    var minDist = Math.max(2, Math.round(fps * 60 / params.maxBpm * 0.7));

    // 적응형 임계값: 시그널 에너지 기반
    var energy = 0;
    for (var i = 0; i < norm.length; i++) energy += norm[i] * norm[i];
    energy /= norm.length;
    var threshold = Math.max(0.05, Math.sqrt(energy) * 0.3);

    for (var i = 2; i < norm.length - 2; i++) {
      // 5포인트 극대점
      if (norm[i] > norm[i-1] && norm[i] > norm[i-2] &&
          norm[i] > norm[i+1] && norm[i] > norm[i+2] &&
          norm[i] >= threshold) {
        if (!peaks.length || (i - peaks[peaks.length-1]) >= minDist) {
          peaks.push(i);
        } else if (norm[i] > norm[peaks[peaks.length-1]]) {
          // 더 높은 피크로 교체
          peaks[peaks.length-1] = i;
        }
      }
    }
    return peaks;
  }

  /**
   * 피크 간격에서 BPM 계산 (이상치 제거 포함)
   */
  _bpmFromPeaks(peakIndices, ts, params) {
    if (peakIndices.length < 2) return null;

    // 피크 간 실제 시간 간격 (ms)
    var intervals = [];
    for (var i = 1; i < peakIndices.length; i++) {
      var dt = ts[peakIndices[i]] - ts[peakIndices[i-1]];
      if (dt > 0) intervals.push(dt);
    }

    if (intervals.length < 1) return null;

    // 이상치 제거 (중앙값 기준 ±50%)
    if (intervals.length >= 3) {
      var sorted = intervals.slice().sort(function(a,b){ return a-b; });
      var median = sorted[Math.floor(sorted.length / 2)];
      var filtered = [];
      for (var i = 0; i < intervals.length; i++) {
        if (intervals[i] > median * 0.5 && intervals[i] < median * 1.5) {
          filtered.push(intervals[i]);
        }
      }
      if (filtered.length >= 1) {
        var avg = 0;
        for (var i = 0; i < filtered.length; i++) avg += filtered[i];
        avg /= filtered.length;
        return Math.round(60000 / avg);
      }
    }

    // 이상치 제거 불가 시 단순 계산
    var totalDur = ts[peakIndices[peakIndices.length-1]] - ts[peakIndices[0]];
    if (totalDur <= 0) return null;
    return Math.round(60000 / (totalDur / (peakIndices.length - 1)));
  }

  // 선형 트렌드 제거 (최소자승법)
  _detrend(sig) {
    var n = sig.length;
    var sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (var i = 0; i < n; i++) {
      sx += i; sy += sig[i]; sxy += i * sig[i]; sx2 += i * i;
    }
    var denom = n * sx2 - sx * sx;
    if (Math.abs(denom) < 1e-10) {
      var avg = sy / n;
      var out = [];
      for (var i = 0; i < n; i++) out.push(sig[i] - avg);
      return out;
    }
    var slope = (n * sxy - sx * sy) / denom;
    var intercept = (sy - slope * sx) / n;
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(sig[i] - (slope * i + intercept));
    }
    return out;
  }

  // 이동평균 스무딩
  _smooth(sig, w) {
    if (w < 2) return sig.slice();
    var half = Math.floor(w / 2);
    var out = [];
    for (var i = 0; i < sig.length; i++) {
      var sum = 0, c = 0;
      var lo = Math.max(0, i - half);
      var hi = Math.min(sig.length - 1, i + half);
      for (var j = lo; j <= hi; j++) {
        sum += sig[j]; c++;
      }
      out.push(sum / c);
    }
    return out;
  }
}

window.BreathingAnalyzer = BreathingAnalyzer;
