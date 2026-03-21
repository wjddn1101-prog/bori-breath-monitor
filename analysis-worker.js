/**
 * analysis-worker.js — Web Worker for heavy signal analysis
 * 메인 스레드 프레임 드랍 방지를 위해 분석 연산을 분리
 */
'use strict';

self.onmessage = function(e) {
  var d = e.data;
  var result = analyzeSignal(d.signal, d.timestamps, d.params, d.fps);
  self.postMessage(result);
};

function analyzeSignal(sig, ts, params, fps) {
  var empty = { bpm: null, confidence: 0, smoothedSignal: [], peaks: [], acBpm: null, fftBpm: null, peakBpm: null };
  if (!sig || sig.length < 30) return empty;

  var duration = (ts[ts.length - 1] - ts[0]) / 1000;
  if (duration < 3) return empty;

  // 1. 선형 트렌드 제거
  var detrended = detrend(sig);

  // 2. 이동평균 스무딩
  var smoothed = smooth(detrended, params.smoothW);

  // 3. 정규화
  var maxAbs = 0;
  for (var i = 0; i < smoothed.length; i++) {
    var a = Math.abs(smoothed[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs < 0.0001) return empty;

  var norm = new Array(smoothed.length);
  for (var i = 0; i < smoothed.length; i++) norm[i] = smoothed[i] / maxAbs;

  // 4. 자기상관 분석
  var minLag = Math.max(2, Math.round(fps * 60 / params.maxBpm));
  var maxLag = Math.min(Math.floor(norm.length / 2), Math.round(fps * 60 / params.minBpm));
  var acResult = autocorrelation(norm, minLag, maxLag);

  // 5. FFT 주파수 분석
  var fftResult = fftAnalysis(norm, fps, params);

  // 6. 피크 카운팅
  var peakIndices = findPeaks(norm, fps, params);
  var peakBpm = bpmFromPeaks(peakIndices, ts, params);

  // 각 방법의 BPM 추출
  var acBpm = null, acConf = 0;
  if (acResult) {
    acBpm = Math.round(60 / (acResult.lag / fps));
    acConf = acResult.confidence;
  }
  var fftBpm = fftResult ? fftResult.bpm : null;
  var fftConf = fftResult ? fftResult.confidence : 0;

  // 7. 3중 교차 검증
  var final = crossValidate(acBpm, acConf, fftBpm, fftConf, peakBpm, params, duration);

  return {
    bpm: final.bpm,
    confidence: final.confidence,
    smoothedSignal: norm,
    peaks: peakIndices,
    acBpm: acBpm,
    fftBpm: fftBpm,
    peakBpm: peakBpm
  };
}

// ========== 3중 교차 검증 ==========
function crossValidate(acBpm, acConf, fftBpm, fftConf, peakBpm, params, duration) {
  var candidates = [];
  if (acBpm !== null && acBpm >= params.minBpm && acBpm <= params.maxBpm) {
    candidates.push({ bpm: acBpm, conf: acConf, weight: 3, name: 'ac' });
  }
  if (fftBpm !== null && fftBpm >= params.minBpm && fftBpm <= params.maxBpm) {
    candidates.push({ bpm: fftBpm, conf: fftConf, weight: 2, name: 'fft' });
  }
  if (peakBpm !== null && peakBpm >= params.minBpm && peakBpm <= params.maxBpm) {
    candidates.push({ bpm: peakBpm, conf: 0.3, weight: 1, name: 'peak' });
  }

  if (candidates.length === 0) return { bpm: null, confidence: 0 };

  // 최소 사이클 확인
  for (var i = 0; i < candidates.length; i++) {
    var expectedCycles = duration / (60 / candidates[i].bpm);
    if (expectedCycles < params.minCycles) {
      candidates[i].conf *= 0.5;
    }
  }

  // 2개 이상 일치하는 쌍 찾기 (±20% 이내)
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
          // 일치 보너스: 두 방법이 합의하면 신뢰도 상승
          var agreeBonus = 1.0 + (candidates.length >= 3 ? 0.15 : 0.1);
          var finalConf = Math.min(1, wConf * agreeBonus);
          if (!bestAgreement || finalConf > bestAgreement.confidence) {
            bestAgreement = { bpm: wBpm, confidence: finalConf };
          }
        }
      }
    }
    // 3개 모두 일치 시 추가 보너스
    if (candidates.length === 3 && bestAgreement) {
      var allClose = true;
      for (var i = 0; i < candidates.length && allClose; i++) {
        for (var j = i + 1; j < candidates.length && allClose; j++) {
          var d = Math.abs(candidates[i].bpm - candidates[j].bpm) / Math.max(candidates[i].bpm, 1);
          if (d >= 0.2) allClose = false;
        }
      }
      if (allClose) {
        bestAgreement.confidence = Math.min(1, bestAgreement.confidence * 1.15);
      }
    }
    if (bestAgreement) return bestAgreement;
  }

  // 일치하는 쌍 없음 — 신뢰도×가중치가 가장 높은 후보 사용
  candidates.sort(function(a, b) { return (b.conf * b.weight) - (a.conf * a.weight); });
  return { bpm: candidates[0].bpm, confidence: candidates[0].conf };
}

// ========== FFT 주파수 분석 ==========
function fftAnalysis(norm, fps, params) {
  // 2의 거듭제곱으로 제로패딩
  var n = 1;
  while (n < norm.length) n <<= 1;

  var re = new Array(n);
  var im = new Array(n);
  for (var i = 0; i < n; i++) {
    re[i] = i < norm.length ? norm[i] : 0;
    im[i] = 0;
  }

  fft(re, im, n);

  // 파워 스펙트럼 (0 ~ fs/2)
  var freqResolution = fps / n;
  var minFreq = params.minBpm / 60;  // Hz
  var maxFreq = params.maxBpm / 60;  // Hz
  var minBin = Math.max(1, Math.floor(minFreq / freqResolution));
  var maxBin = Math.min(n / 2, Math.ceil(maxFreq / freqResolution));

  var bestPower = 0, bestBin = 0, totalPower = 0;
  for (var i = minBin; i <= maxBin; i++) {
    var power = re[i] * re[i] + im[i] * im[i];
    totalPower += power;
    if (power > bestPower) {
      bestPower = power;
      bestBin = i;
    }
  }

  if (bestBin === 0 || totalPower < 0.0001) return null;

  // 이차 보간 (parabolic interpolation)으로 주파수 정밀도 향상
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

  var peakFreq = precBin * freqResolution;
  var bpm = Math.round(peakFreq * 60);
  var confidence = bestPower / (totalPower + 0.0001);

  if (bpm < params.minBpm || bpm > params.maxBpm) return null;
  return { bpm: bpm, confidence: Math.min(1, confidence * 3) };
}

// Radix-2 FFT (in-place)
function fft(re, im, n) {
  // 비트 반전 순서
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      var t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // 버터플라이 연산
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

// ========== 자기상관 ==========
function autocorrelation(signal, minLag, maxLag) {
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

// ========== 피크 검출 ==========
function findPeaks(norm, fps, params) {
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

function bpmFromPeaks(peakIndices, ts, params) {
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

  var totalDur = ts[peakIndices[peakIndices.length - 1]] - ts[peakIndices[0]];
  if (totalDur <= 0) return null;
  return Math.round(60000 / (totalDur / (peakIndices.length - 1)));
}

// ========== 유틸리티 ==========
function detrend(sig) {
  var n = sig.length;
  var sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (var i = 0; i < n; i++) {
    sx += i; sy += sig[i]; sxy += i * sig[i]; sx2 += i * i;
  }
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

function smooth(sig, w) {
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
