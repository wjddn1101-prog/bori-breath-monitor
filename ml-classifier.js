/**
 * ml-classifier.js — TensorFlow.js 기반 호흡 신호 품질 분류기
 *
 * - 1D Dense 네트워크: 호흡 신호 창 → 호흡 신호 여부(0~1) 분류
 * - 초기화: 합성 데이터(사인파 + 노이즈)로 사전 학습
 * - 사용자 피드백(맞아요/틀렸어요) 누적 시 브라우저 내 재학습
 * - 모델 가중치 IndexedDB 저장/로드 (오프라인 지속)
 */

(function() {
  'use strict';

  var WINDOW_SIZE = 150;
  var MODEL_KEY = 'indexeddb://bori-classifier';
  var ML_DATA_KEY = 'bori_ml_classifier_buf';

  function BreathingClassifier() {
    this.model = null;
    this.isReady = false;
    this._feedbackBuf = { sigs: [], labels: [] };
  }

  BreathingClassifier.prototype.init = async function() {
    if (typeof tf === 'undefined') {
      console.warn('TensorFlow.js 미로드 — 분류기 비활성화');
      return;
    }
    // 저장된 모델 로드 시도
    try {
      this.model = await tf.loadLayersModel(MODEL_KEY);
      this.isReady = true;
      console.log('ML 분류기: IndexedDB에서 로드 완료');
      return;
    } catch (e) {}

    // 새 모델 빌드 + 합성 데이터 학습
    this._buildModel();
    await this._trainOnSyntheticData();
    try { await this.model.save(MODEL_KEY); } catch (e) {}
    this.isReady = true;
    console.log('ML 분류기: 합성 데이터로 초기화 완료');
  };

  BreathingClassifier.prototype._buildModel = function() {
    this.model = tf.sequential({
      layers: [
        tf.layers.dense({ inputShape: [WINDOW_SIZE], units: 32, activation: 'relu' }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({ units: 16, activation: 'relu' }),
        tf.layers.dense({ units: 1, activation: 'sigmoid' })
      ]
    });
    this.model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    });
  };

  // 합성 학습 데이터 생성
  //   양성(1): 0.1–1.0Hz 사인파 + 소량 노이즈 — 실제 호흡 신호 모방
  //   음성(0): 순수 노이즈, 램프, 계단 함수 — 잘못된 신호 모방
  BreathingClassifier.prototype._generateSyntheticData = function() {
    var W = WINDOW_SIZE;
    var xs = [], ys = [];

    function normalize(arr) {
      var max = 0;
      for (var i = 0; i < arr.length; i++) if (Math.abs(arr[i]) > max) max = Math.abs(arr[i]);
      return arr.map(function(v) { return max > 0.0001 ? v / max : v; });
    }

    // 양성: 호흡 주파수 사인파
    for (var i = 0; i < 60; i++) {
      var freq = 0.1 + Math.random() * 0.9;
      var phase = Math.random() * 2 * Math.PI;
      var noise = 0.1 + Math.random() * 0.3;
      var sig = [];
      for (var j = 0; j < W; j++) {
        sig.push(Math.sin(2 * Math.PI * freq * j / 30 + phase) + (Math.random() - 0.5) * noise);
      }
      xs.push(normalize(sig));
      ys.push(1);
    }

    // 음성: 화이트 노이즈
    for (var i = 0; i < 40; i++) {
      var sig = [];
      for (var j = 0; j < W; j++) sig.push((Math.random() - 0.5) * 2);
      xs.push(sig);
      ys.push(0);
    }

    // 음성: 선형 드리프트 (느린 조명 변화)
    for (var i = 0; i < 20; i++) {
      var slope = (Math.random() - 0.5) * 2;
      var sig = [];
      for (var j = 0; j < W; j++) sig.push(slope * j / W + (Math.random() - 0.5) * 0.1);
      xs.push(normalize(sig));
      ys.push(0);
    }

    // 음성: 고주파 진동 (털 흔들림)
    for (var i = 0; i < 20; i++) {
      var freq = 1.5 + Math.random() * 3;
      var sig = [];
      for (var j = 0; j < W; j++) sig.push(Math.sin(2 * Math.PI * freq * j / 30) * 0.5 + (Math.random() - 0.5) * 0.5);
      xs.push(normalize(sig));
      ys.push(0);
    }

    return { xs: xs, ys: ys };
  };

  BreathingClassifier.prototype._trainOnSyntheticData = async function() {
    var data = this._generateSyntheticData();
    var xT = tf.tensor2d(data.xs);
    var yT = tf.tensor2d(data.ys, [data.ys.length, 1]);
    await this.model.fit(xT, yT, { epochs: 25, batchSize: 16, shuffle: true, verbose: 0 });
    xT.dispose();
    yT.dispose();
  };

  // 신호 창에 대한 분류 신뢰도 반환 (0~1, 높을수록 호흡 신호)
  BreathingClassifier.prototype.predict = function(signal) {
    if (!this.isReady || !this.model) return 0.5;
    var W = WINDOW_SIZE;
    var sig = signal.slice(-W);
    while (sig.length < W) sig.unshift(0);

    var max = 0;
    for (var i = 0; i < sig.length; i++) if (Math.abs(sig[i]) > max) max = Math.abs(sig[i]);
    var norm = sig.map(function(v) { return max > 0.0001 ? v / max : v; });

    return tf.tidy(function() {
      var input = tf.tensor2d([norm]);
      return this.model.predict(input).dataSync()[0];
    }.bind(this));
  };

  // 사용자 피드백 샘플 추가
  BreathingClassifier.prototype.addFeedback = function(signal, isCorrect) {
    var W = WINDOW_SIZE;
    var sig = signal.slice(-W);
    while (sig.length < W) sig.unshift(0);
    var max = 0;
    for (var i = 0; i < sig.length; i++) if (Math.abs(sig[i]) > max) max = Math.abs(sig[i]);
    this._feedbackBuf.sigs.push(sig.map(function(v) { return max > 0.0001 ? v / max : v; }));
    this._feedbackBuf.labels.push(isCorrect ? 1 : 0);
  };

  // 누적 피드백으로 재학습 (2개 이상 누적 시 실행)
  BreathingClassifier.prototype.retrain = async function() {
    if (this._feedbackBuf.sigs.length < 2) return;
    var xT = tf.tensor2d(this._feedbackBuf.sigs);
    var yT = tf.tensor2d(this._feedbackBuf.labels, [this._feedbackBuf.labels.length, 1]);
    await this.model.fit(xT, yT, { epochs: 8, batchSize: 2, shuffle: true, verbose: 0 });
    xT.dispose();
    yT.dispose();
    try { await this.model.save(MODEL_KEY); } catch (e) {}
    this._feedbackBuf = { sigs: [], labels: [] };
    console.log('ML 분류기: 사용자 피드백으로 재학습 완료');
  };

  // TF.js 로드 후 자동 초기화
  function initWhenReady() {
    window.breathingClassifier = new BreathingClassifier();
    window.breathingClassifier.init().then(function() {
      // analyzer가 이미 생성되어 있으면 분류기 주입
      if (window._analyzerInstance) {
        window._analyzerInstance._classifier = window.breathingClassifier;
      }
    });
  }

  // TF.js 로드 완료 대기
  if (typeof tf !== 'undefined') {
    initWhenReady();
  } else {
    // TF.js 스크립트 로드 완료 이벤트 대기
    document.addEventListener('tfjs-ready', initWhenReady);
    // 폴백: 3초마다 체크
    var checkCount = 0;
    var checkInterval = setInterval(function() {
      checkCount++;
      if (typeof tf !== 'undefined') {
        clearInterval(checkInterval);
        initWhenReady();
      }
      if (checkCount > 20) clearInterval(checkInterval);  // 1분 후 포기
    }, 3000);
  }

})();
