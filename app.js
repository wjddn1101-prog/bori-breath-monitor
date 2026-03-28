(function() {
  'use strict';

  const $ = s => document.querySelector(s);
  const STORAGE_KEY = 'bori_breath_records';

  // ========== 탭 네비게이션 ==========
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      $(`#${btn.dataset.tab}-tab`).classList.add('active');
      if (btn.dataset.tab === 'history') renderHistory();
    });
  });

  // ========== 모드 전환 ==========
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.mode-content').forEach(m => m.classList.remove('active'));
      $(`#${btn.dataset.mode}-mode`).classList.add('active');
    });
  });

  // =============================================
  //  수동 탭 모드 — 탭하면 자동 시작
  // =============================================
  let manualRunning = false;
  let manualStartTime = null;
  let manualTimerId = null;
  let tapTimes = [];

  const btnTap = $('#btn-tap');
  const btnManualStop = $('#btn-manual-stop');
  const btnManualReset = $('#btn-manual-reset');
  const manualBpm = $('#manual-bpm');
  const manualBpmCircle = $('#manual-bpm-circle');
  const manualStatusText = $('#manual-status-text');
  const tapCountNum = $('#tap-count-num');
  const manualElapsed = $('#manual-elapsed');
  const tapIntervalBars = $('#tap-interval-bars');

  function startManual() {
    manualRunning = true;
    manualStartTime = Date.now();
    tapTimes = [];
    acquireWakeLock();
    manualBpm.textContent = '--';
    manualBpmCircle.className = 'bpm-circle active';
    manualStatusText.textContent = '보리가 숨 쉴 때마다 탭하세요';
    manualStatusText.className = '';
    tapCountNum.textContent = '0';
    tapIntervalBars.innerHTML = '';
    btnManualStop.classList.remove('hidden');
    updateManualTimer();
  }

  // iOS 호환 탭 핸들러: touchstart + click 동시 등록 (중복 방지)
  let tapHandled = false;
  function onTapDown(e) {
    e.preventDefault();
    if (tapHandled) return;
    tapHandled = true;
    setTimeout(function() { tapHandled = false; }, 100);
    if (!manualRunning) { startManual(); }
    handleTap();
  }
  btnTap.addEventListener('touchstart', onTapDown, { passive: false });
  btnTap.addEventListener('click', onTapDown);

  btnManualStop.addEventListener('click', function() { finishManual(); });

  btnManualReset.addEventListener('click', function() {
    stopManual();
    manualBpm.textContent = '--';
    manualBpmCircle.className = 'bpm-circle';
    manualStatusText.textContent = '탭하면 자동으로 시작됩니다';
    manualStatusText.className = '';
    tapCountNum.textContent = '0';
    manualElapsed.textContent = '0:00';
    tapIntervalBars.innerHTML = '';
  });

  function handleTap() {
    var now = Date.now();
    tapTimes.push(now);
    tapCountNum.textContent = tapTimes.length;

    btnTap.classList.add('flash');
    var circle = btnTap.querySelector('.bpm-circle') || btnTap;
    circle.classList.add('active');
    setTimeout(function() { btnTap.classList.remove('flash'); circle.classList.remove('active'); }, 120);

    if (tapTimes.length >= 2) {
      var bpm = calcManualBpm();
      manualBpm.textContent = bpm;
      updateManualStatus(bpm);
    }
    updateIntervalBars();
  }

  function calcManualBpm() {
    if (tapTimes.length < 2) return null;
    var first = tapTimes[0];
    var last = tapTimes[tapTimes.length - 1];
    var dur = last - first;
    if (dur <= 0) return null;
    return Math.round(((tapTimes.length - 1) / dur) * 60000);
  }

  function updateManualStatus(bpm) {
    if (bpm >= 40) {
      manualBpmCircle.className = 'bpm-circle danger';
      manualStatusText.textContent = '위험! 즉시 동물병원 방문!';
      manualStatusText.className = 'danger';
    } else if (bpm >= 30) {
      manualBpmCircle.className = 'bpm-circle warning';
      manualStatusText.textContent = '주의 - 호흡수가 높습니다';
      manualStatusText.className = 'warning';
    } else {
      manualBpmCircle.className = 'bpm-circle active';
      manualStatusText.textContent = '정상 범위';
      manualStatusText.className = 'normal';
    }
  }

  function updateIntervalBars() {
    tapIntervalBars.innerHTML = '';
    if (tapTimes.length < 2) return;
    var intervals = [];
    for (var i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i-1]);
    var recent = intervals.slice(-20);
    var maxI = Math.max.apply(null, recent.concat([1]));
    recent.forEach(function(iv) {
      var bar = document.createElement('div');
      bar.className = 'interval-bar';
      bar.style.height = Math.max(4, (iv / maxI) * 36) + 'px';
      var iBpm = 60000 / iv;
      if (iBpm >= 40) bar.classList.add('danger');
      else if (iBpm >= 30) bar.classList.add('warning');
      tapIntervalBars.appendChild(bar);
    });
  }

  function updateManualTimer() {
    if (!manualRunning) return;
    var elapsed = Math.round((Date.now() - manualStartTime) / 1000);
    manualElapsed.textContent = Math.floor(elapsed/60) + ':' + (elapsed%60 < 10 ? '0' : '') + (elapsed%60);
    manualTimerId = requestAnimationFrame(updateManualTimer);
  }

  function finishManual() {
    var bpm = calcManualBpm();
    stopManual();
    // 진동 피드백
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    if (bpm !== null && tapTimes.length >= 3) {
      var elapsed = Math.round((Date.now() - (manualStartTime || Date.now())) / 1000);
      showResultModal(bpm, elapsed, 'manual', tapTimes.length);
    } else {
      showAlert('측정 부족', '최소 3번 이상 탭해야 합니다.', '보리가 숨 쉴 때마다 탭 버튼을 눌러주세요.');
    }
  }

  function stopManual() {
    manualRunning = false;
    releaseWakeLock();
    btnManualStop.classList.add('hidden');
    if (manualTimerId) { cancelAnimationFrame(manualTimerId); manualTimerId = null; }
  }


  // =============================================
  //  자동 영상분석 모드
  // =============================================
  var analyzer = new BreathingAnalyzer();
  window._analyzerInstance = analyzer;  // Phase 3: TF.js 분류기 주입용
  var stream = null;
  var videoTrack = null;
  var isMeasuring = false;
  var animId = null;

  // OpenCV 콜백
  window.openCvReady = false;
  window.onOpenCvReady = function() {
    if (window.openCvReady) return;
    window.openCvReady = true;
    var loadMsg = $('#opencv-loading-msg');
    var startMsg = $('#camera-start-msg');
    var btnCamera = $('#btn-camera');
    if (loadMsg) loadMsg.classList.add('hidden');
    if (startMsg) startMsg.classList.remove('hidden');
    if (btnCamera) {
      btnCamera.disabled = false;
      btnCamera.classList.remove('disabled');
    }
  };

  // 폴백: 0.5초마다 cv 및 cv.Mat 로드 상태 확인 (iOS 사파리 대응)
  var cvCheckCount = 0;
  var cvCheckInterval = setInterval(function() {
    if (window.openCvReady) {
      clearInterval(cvCheckInterval);
      return;
    }
    // WebAssembly 초기화가 끝나면 cv.Mat이 함수로 존재함
    if (typeof cv !== 'undefined' && typeof cv.Mat !== 'undefined') {
      clearInterval(cvCheckInterval);
      window.onOpenCvReady();
    }
    cvCheckCount++;
    if (cvCheckCount > 40) { // 20초 경과시
      clearInterval(cvCheckInterval);
      var loadMsg = $('#opencv-loading-msg');
      if (loadMsg) loadMsg.innerHTML = "OpenCV 로딩 실패.<br>인터넷 연결을 확인하고 새로고침 해주세요.<br>(Safari의 경우 캐시 비우기 권장)";
    }
  }, 500);

  // 비동기로 미리 로드되었을 경우 즉시 초기화
  if (window.openCvReadyFlag) {
    window.onOpenCvReady();
  }

  // === Wake Lock (화면 꺼짐 방지) ===
  var wakeLock = null;
  function acquireWakeLock() {
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(function(lock) {
        wakeLock = lock;
        wakeLock.addEventListener('release', function() { wakeLock = null; });
      }).catch(function() {});
    }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(function() {}); wakeLock = null; }
  }
  var autoTimerId = null;
  var autoBpmHistory = [];
  var currentAutoBpm = null;

  // ROI
  var roiMode = false;
  var roiDragging = false;
  var roiStartPt = null;
  var currentROI = null;

  // 플래시
  var flashOn = false;

  var video = $('#video');
  var overlayCanvas = $('#overlay-canvas');
  var overlayCtx = overlayCanvas.getContext('2d');

  // --- 카메라 ---
  $('#btn-camera').addEventListener('click', function() {
    if (stream) { stopCamera(); return; }
    startCamera();
  });

  function startCamera() {
    // HTTPS 또는 localhost가 아니면 카메라 API 사용 불가
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showAlert('카메라 오류',
        '카메라를 사용할 수 없습니다.',
        'HTTPS 연결이 필요합니다.\n\n현재: ' + location.protocol + '//' + location.host +
        '\n\nSafari에서 https:// 주소로 접속해주세요.');
      return;
    }
    var facingMode = $('#camera-select').value;
    try {
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: facingMode, width: {ideal:640}, height: {ideal:480} },
        audio: false,
      }).then(function(s) {
        stream = s;
        video.srcObject = stream;
        video.play();

        videoTrack = stream.getVideoTracks()[0];
        $('#no-camera').classList.add('hidden');
        $('#btn-camera').textContent = '카메라 중지';
        $('#btn-roi').classList.add('hidden');
        $('#btn-auto-measure').classList.add('hidden');
        $('#light-controls').classList.remove('hidden');
        setAutoStatus('카메라 안정화 중...', 'ready');
        
        // 카메라를 켜면 자동으로 화면 중앙 70%를 관심영역으로 설정
        currentROI = { x: 0.15, y: 0.15, w: 0.7, h: 0.7 };
        analyzer.setROI(currentROI, false);  // userSet=false → 측정 시 ROI 자동 탐색 실행
        
        fitOverlay();
        window.addEventListener('resize', fitOverlay);
        checkFlashCapability();
        
        // 1초 뒤 자동 측정 시작
        setTimeout(function() {
            if (stream) startAutoMeasure();
        }, 1000);
      }).catch(function(e) {
        showAlert('카메라 오류', '카메라에 접근할 수 없습니다.', '브라우저 설정에서 카메라 권한을 허용해주세요.\n\n' + (e.message || e));
      });
    } catch(e) {
      showAlert('카메라 오류', '카메라 API를 사용할 수 없습니다.', e.message || String(e));
    }
  }

  function stopCamera() {
    if (flashOn) toggleFlash();
    if (stream) { stream.getTracks().forEach(function(t) { t.stop(); }); stream = null; videoTrack = null; }
    video.srcObject = null;
    $('#no-camera').classList.remove('hidden');
    $('#btn-camera').textContent = '카메라 시작';
    $('#btn-roi').classList.add('hidden');
    $('#btn-auto-measure').classList.add('hidden');
    $('#btn-auto-stop').classList.add('hidden');
    $('#auto-bpm-display').classList.add('hidden');
    $('#light-controls').classList.add('hidden');
    setBrightness(0);
    currentROI = null;
    setAutoStatus('카메라를 시작하세요', 'idle');
    stopAutoMeasure();
  }

  function fitOverlay() {
    overlayCanvas.width = overlayCanvas.clientWidth;
    overlayCanvas.height = overlayCanvas.clientHeight;
    if (currentROI) drawROIRect(currentROI);
  }

  // --- 플래시 (torch) ---
  function checkFlashCapability() {
    if (!videoTrack) return;
    try {
      var caps = videoTrack.getCapabilities();
      if (caps && caps.torch) {
        $('#btn-flash').style.display = 'flex';
      } else {
        $('#btn-flash').style.display = 'flex';
      }
    } catch(e) {
      $('#btn-flash').style.display = 'flex';
    }
  }

  $('#btn-flash').addEventListener('click', function() { toggleFlash(); });

  function toggleFlash() {
    if (!videoTrack) return;
    flashOn = !flashOn;
    videoTrack.applyConstraints({ advanced: [{ torch: flashOn }] }).then(function() {
      $('#btn-flash').classList.toggle('on', flashOn);
      $('#flash-icon').textContent = flashOn ? '💡' : '🔦';
      $('#flash-label').textContent = flashOn ? '플래시 끄기' : '플래시 켜기';
      // 플래시 켜면 밝기 조절 팁 표시
      var tip = $('#flash-tip');
      if (tip) {
        if (flashOn) tip.classList.remove('hidden');
        else tip.classList.add('hidden');
      }
    }).catch(function(e) {
      flashOn = false;
      $('#btn-flash').classList.remove('on');
      showAlert('플래시 오류', '이 기기에서 플래시를 지원하지 않습니다.', '보조 조명(화면 밝기) 슬라이더를 사용해보세요.');
    });
  }

  // --- 화면 밝기 (소프트웨어 조명) ---
  var brightnessSlider = $('#brightness-slider');
  var screenLight = $('#screen-light');

  brightnessSlider.addEventListener('input', function() {
    setBrightness(parseInt(brightnessSlider.value));
  });

  function setBrightness(val) {
    brightnessSlider.value = val;
    if (val === 0) {
      screenLight.classList.add('hidden');
    } else {
      screenLight.classList.remove('hidden');
      var alpha = (val / 100) * 0.6;
      screenLight.style.background = 'rgba(255, 255, 240, ' + alpha + ')';
    }
  }

  // --- ROI 선택 ---
  $('#btn-roi').addEventListener('click', function() {
    if (roiMode) { exitROIMode(); return; }
    enterROIMode();
  });

  function enterROIMode() {
    roiMode = true;
    $('#btn-roi').textContent = '취소';
    $('#roi-instruction').classList.remove('hidden');
    overlayCanvas.style.pointerEvents = 'auto';
    overlayCanvas.style.cursor = 'crosshair';
    setAutoStatus('드래그로 영역 선택', 'ready');
  }

  function exitROIMode() {
    roiMode = false;
    roiDragging = false;
    roiStartPt = null;
    $('#btn-roi').textContent = '영역 선택';
    $('#roi-instruction').classList.add('hidden');
    overlayCanvas.style.pointerEvents = 'none';
    overlayCanvas.style.cursor = 'default';
  }

  // ROI 터치/마우스 통합 핸들러 (iOS 호환)
  function getEventXY(e) {
    if (e.touches && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    if (e.changedTouches && e.changedTouches.length > 0) {
      return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  function onROIDown(e) {
    if (!roiMode) return;
    e.preventDefault();
    roiDragging = true;
    var rect = overlayCanvas.getBoundingClientRect();
    var pt = getEventXY(e);
    roiStartPt = {
      x: (pt.x - rect.left) / rect.width,
      y: (pt.y - rect.top) / rect.height,
    };
  }

  function onROIMove(e) {
    if (!roiDragging || !roiStartPt) return;
    e.preventDefault();
    var rect = overlayCanvas.getBoundingClientRect();
    var pt = getEventXY(e);
    var cx = (pt.x - rect.left) / rect.width;
    var cy = (pt.y - rect.top) / rect.height;
    drawROIPreview(roiStartPt.x, roiStartPt.y, cx, cy);
  }

  function onROIUp(e) {
    if (!roiDragging || !roiStartPt) return;
    e.preventDefault();
    roiDragging = false;
    var rect = overlayCanvas.getBoundingClientRect();
    var pt = getEventXY(e);
    var cx = (pt.x - rect.left) / rect.width;
    var cy = (pt.y - rect.top) / rect.height;

    var roi = {
      x: Math.max(0, Math.min(roiStartPt.x, cx)),
      y: Math.max(0, Math.min(roiStartPt.y, cy)),
      w: Math.abs(cx - roiStartPt.x),
      h: Math.abs(cy - roiStartPt.y),
    };

    if (roi.w < 0.05 || roi.h < 0.05) { roiStartPt = null; return; }

    currentROI = roi;
    analyzer.setROI(roi, true);  // userSet=true → 사용자 지정 ROI 유지
    exitROIMode();
    drawROIRect(roi);
    $('#btn-auto-measure').classList.remove('hidden');
    setAutoStatus('측정 준비 완료', 'ready');
  }

  function onROICancel() { roiDragging = false; roiStartPt = null; }

  // touch (iOS) + mouse (desktop) 이벤트 등록
  overlayCanvas.addEventListener('touchstart', onROIDown, { passive: false });
  overlayCanvas.addEventListener('touchmove', onROIMove, { passive: false });
  overlayCanvas.addEventListener('touchend', onROIUp, { passive: false });
  overlayCanvas.addEventListener('touchcancel', onROICancel);
  overlayCanvas.addEventListener('mousedown', onROIDown);
  overlayCanvas.addEventListener('mousemove', onROIMove);
  overlayCanvas.addEventListener('mouseup', onROIUp);

  function drawROIPreview(x1, y1, x2, y2) {
    var w = overlayCanvas.width, h = overlayCanvas.height;
    overlayCtx.clearRect(0, 0, w, h);
    overlayCtx.fillStyle = 'rgba(0,0,0,0.4)';
    overlayCtx.fillRect(0, 0, w, h);
    var rx = Math.min(x1,x2)*w, ry = Math.min(y1,y2)*h;
    var rw = Math.abs(x2-x1)*w, rh = Math.abs(y2-y1)*h;
    overlayCtx.clearRect(rx, ry, rw, rh);
    overlayCtx.strokeStyle = '#4a90d9';
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([6,4]);
    overlayCtx.strokeRect(rx, ry, rw, rh);
    overlayCtx.setLineDash([]);
  }

  function drawROIRect(roi) {
    var w = overlayCanvas.width, h = overlayCanvas.height;
    overlayCtx.clearRect(0, 0, w, h);
    var rx = roi.x*w, ry = roi.y*h, rw = roi.w*w, rh = roi.h*h;
    overlayCtx.strokeStyle = isMeasuring ? '#4caf50' : '#4a90d9';
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeRect(rx, ry, rw, rh);
    var label = isMeasuring ? '측정 중' : '측정 영역';
    overlayCtx.fillStyle = isMeasuring ? 'rgba(76,175,80,0.8)' : 'rgba(74,144,217,0.8)';
    overlayCtx.fillRect(rx, ry-20, 70, 20);
    overlayCtx.fillStyle = '#fff';
    overlayCtx.font = '11px sans-serif';
    overlayCtx.fillText(label, rx+6, ry-5);
  }

  // --- 자동 측정 (버튼은 숨김 처리) ---
  $('#btn-auto-measure').addEventListener('click', startAutoMeasure);
  $('#btn-auto-stop').addEventListener('click', function() { stopAutoMeasure(true); });

  function startAutoMeasure() {
    isMeasuring = true;
    autoBpmHistory = [];
    currentAutoBpm = null;

    // Phase 2: 적응 학습 — 비슷한 조도 환경에서의 성공 파라미터 로드
    var adaptiveP = analyzer.loadAdaptiveParams(analyzer._frameBrightness || 80);
    if (adaptiveP && adaptiveP.sampleCount >= 3) {
      $('#sensitivity').value = adaptiveP.sensitivity;
      var badge = $('#adaptive-badge');
      if (badge) badge.classList.remove('hidden');
    } else {
      var badge = $('#adaptive-badge');
      if (badge) badge.classList.add('hidden');
    }

    analyzer.setSensitivity($('#sensitivity').value);

    // Phase 1: ROI 자동 탐색 콜백 설정
    analyzer.onRoiFound = function(roi) {
      currentROI = roi;
      drawROIRect(roi);
      var scanStatus = $('#roi-scan-status');
      if (scanStatus) scanStatus.classList.add('hidden');
    };

    analyzer.start();
    acquireWakeLock();

    $('#btn-auto-measure').classList.add('hidden');
    $('#btn-roi').classList.add('hidden');
    $('#btn-auto-stop').classList.remove('hidden');
    $('#auto-bpm-display').classList.remove('hidden');
    $('#auto-bpm').textContent = '--';
    $('#auto-bpm').className = 'bpm-number';
    $('#auto-breath-status').textContent = '분석 중... (10초 이상 필요)';
    $('#timer-display').classList.remove('hidden');
    setAutoStatus('측정 중...', 'measuring');
    drawROIRect(currentROI);

    // Phase 1: ROI 스캔 모드이면 탐색 상태 표시
    if (!analyzer._roiUserSet) {
      var scanStatus = $('#roi-scan-status');
      if (scanStatus) scanStatus.classList.remove('hidden');
    }

    var duration = parseInt($('#measure-duration').value);
    autoTimerId = setTimeout(function() { stopAutoMeasure(true); }, duration * 1000);
    autoLoop();
  }

  function autoLoop() {
    if (!isMeasuring) return;
    var bpm = analyzer.analyzeFrame(video);

    if (bpm !== null) {
      currentAutoBpm = bpm;
      if (!autoBpmHistory.length || autoBpmHistory[autoBpmHistory.length-1] !== bpm) {
        autoBpmHistory.push(bpm);
      }
    }

    var displayBpm = bpm !== null ? bpm : currentAutoBpm;
    if (displayBpm !== null) {
      $('#auto-bpm').textContent = displayBpm;
      $('#auto-bpm').className = 'bpm-number' + (displayBpm>=40?' danger':displayBpm>=30?' warning':'');
      // 신뢰도 표시
      var conf = analyzer.confidence || 0;
      var confLabel = conf >= 0.5 ? '높음' : conf >= 0.25 ? '보통' : '낮음';
      var statusText = displayBpm>=40?'위험! 즉시 내원!':displayBpm>=30?'주의':'정상 범위';
      $('#auto-breath-status').textContent = statusText + ' (신뢰도: ' + confLabel + ' | 모션 캡처)';
    } else {
      var sec = analyzer.getElapsedSeconds();
      if (sec < 5) {
        $('#auto-breath-status').textContent = '분석 준비 중...';
      } else if (sec < 15) {
        $('#auto-breath-status').textContent = '호흡 패턴 수집 중... (' + sec + '초)';
      } else {
        $('#auto-breath-status').textContent = '호흡 감지 중... 잠시 기다려주세요';
      }
    }

    // 신호 품질 바 업데이트
    var sq = analyzer.signalQuality || 0;
    var sqFill = $('#sq-fill');
    if (sqFill) {
      sqFill.style.width = sq + '%';
      sqFill.className = sq >= 60 ? 'high' : sq >= 35 ? 'mid' : 'low';
    }
    var sqVal = $('#sq-value');
    if (sqVal) sqVal.textContent = sq + '%';

    // 저조도 경고 표시
    var llWarn = $('#low-light-warn');
    if (llWarn) {
      if (analyzer.isLowLight) llWarn.classList.remove('hidden');
      else llWarn.classList.add('hidden');
    }

    var elapsed = analyzer.getElapsedSeconds();
    var dur = parseInt($('#measure-duration').value);
    var rem = Math.max(0, dur - elapsed);
    $('#timer-display').textContent = Math.floor(rem/60) + ':' + (rem%60 < 10 ? '0' : '') + (rem%60);
    drawWave();
    drawTrackingPoints();
    animId = requestAnimationFrame(autoLoop);
  }

  function stopAutoMeasure(showResult) {
    isMeasuring = false;
    analyzer.stop();
    releaseWakeLock();
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    if (autoTimerId) { clearTimeout(autoTimerId); autoTimerId = null; }
    // 진동 피드백: 측정 완료 알림 (iOS 18+)
    if (showResult && navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

    $('#btn-auto-stop').classList.add('hidden');
    $('#timer-display').classList.add('hidden');
    if (stream) {
      setAutoStatus('측정 대기', 'ready');
    }
    if (currentROI) drawROIRect(currentROI);

    if (showResult) {
      var bpm = currentAutoBpm;
      if (!bpm && autoBpmHistory.length > 0) {
        var sorted = autoBpmHistory.slice().sort(function(a,b){return a-b;});
        bpm = sorted[Math.floor(sorted.length/2)];
      }
      if (bpm) {
        showResultModal(bpm, analyzer.getElapsedSeconds(), 'auto');
      } else {
        showAlert('측정 실패', '호흡을 감지하지 못했습니다.', '영역을 다시 선택하거나 감도를 높여보세요.');
      }
    }
  }

  function drawWave() {
    var canvas = $('#wave-canvas');
    var ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth;
    canvas.height = 50;

    var sig = analyzer.smoothedSignal;
    var peaks = analyzer.peaks;
    var winStart = analyzer._windowStartIdx || 0;

    if (!sig || sig.length < 2) return;
    var w = canvas.width, h = canvas.height;
    var maxAbs = Math.max.apply(null, sig.map(Math.abs).concat([0.001]));

    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke();

    ctx.strokeStyle = '#4a90d9'; ctx.lineWidth = 1.5; ctx.beginPath();
    sig.forEach(function(v,i) {
      var x = (i/(sig.length-1))*w, y = h/2 - (v/maxAbs)*(h/2-4);
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.stroke();

    ctx.fillStyle = '#4caf50';
    peaks.forEach(function(pi) {
      var li = pi - winStart;
      if (li >= 0 && li < sig.length) {
        var x = (li/(sig.length-1))*w;
        var y = h/2 - (sig[li]/maxAbs)*(h/2-4);
        ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
      }
    });
  }

  function drawTrackingPoints() {
    if (!currentROI || !isMeasuring) return;

    drawROIRect(currentROI);

    if (!analyzer.trackedPoints || analyzer.trackedPoints.length === 0) return;

    var w = overlayCanvas.width, h = overlayCanvas.height;

    // 신호 품질에 따라 점 색상 변경
    var sq = analyzer.signalQuality || 0;
    var dotColor = sq > 60 ? 'rgba(0, 255, 100, 0.8)' : sq > 30 ? 'rgba(255, 200, 0, 0.8)' : 'rgba(255, 80, 80, 0.8)';

    for (var i = 0; i < analyzer.trackedPoints.length; i++) {
        var pt = analyzer.trackedPoints[i];
        var x = pt.x1 * w, y = pt.y1 * h;

        // ROI 격자 분석점 표시
        overlayCtx.fillStyle = dotColor;
        overlayCtx.beginPath();
        overlayCtx.arc(x, y, 3, 0, 2 * Math.PI);
        overlayCtx.fill();
    }

    // 채널 정보 표시
    var ch = analyzer.debugInfo.channel || 'g';
    var chLabel = ch === 'r' ? 'R채널' : ch === 'b' ? 'B채널' : 'G채널';
    overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    overlayCtx.fillRect(4, h - 22, 70, 18);
    overlayCtx.fillStyle = '#fff';
    overlayCtx.font = '11px sans-serif';
    overlayCtx.fillText('밝기분석 ' + chLabel, 8, h - 8);
  }

  function setAutoStatus(text, state) {
    $('#auto-status-text').textContent = text;
    $('#auto-status-dot').className = 'dot-' + state;
  }


  // =============================================
  //  공용: 결과 모달 & 기록
  // =============================================
  function showResultModal(bpm, duration, method, tapCount) {
    var modal = $('#result-modal');
    var now = new Date();
    $('#result-bpm').textContent = bpm;
    $('#result-bpm').style.color = bpm>=40?'var(--red)':bpm>=30?'var(--yellow)':'var(--green)';
    $('#result-status').textContent = bpm>=40?'위험 - 즉시 동물병원!':bpm>=30?'주의 - 호흡수 높음':'정상 범위';
    $('#result-status').style.color = bpm>=40?'var(--red)':bpm>=30?'var(--yellow)':'var(--green)';
    $('#result-icon').textContent = bpm>=40?'🚨':bpm>=30?'⚠️':'🐾';
    $('#result-datetime').textContent =
      now.getFullYear() + '년 ' + (now.getMonth()+1) + '월 ' + now.getDate() + '일 ' + now.getHours() + '시 ' + String(now.getMinutes()).padStart(2,'0') + '분';
    var info = method === 'manual'
      ? '수동 탭 | ' + tapCount + '회 탭 | ' + duration + '초'
      : '자동 영상분석 | ' + duration + '초';
    $('#result-info').textContent = info;
    $('#result-memo').value = '';
    modal.classList.remove('hidden');

    // Phase 2: 피드백 버튼 — 측정이 정확한지 여부 기록
    var feedbackRow = $('#result-feedback-row');
    if (feedbackRow) feedbackRow.classList.remove('hidden');
    var feedbackDone = false;
    function onFeedback(isCorrect) {
      if (feedbackDone) return;
      feedbackDone = true;
      saveMLData(bpm, method, isCorrect);
      var correctBtn = $('#result-correct');
      var incorrectBtn = $('#result-incorrect');
      if (correctBtn) correctBtn.classList.toggle('selected', isCorrect);
      if (incorrectBtn) incorrectBtn.classList.toggle('selected', !isCorrect);
    }
    var correctBtn = $('#result-correct');
    var incorrectBtn = $('#result-incorrect');
    if (correctBtn) correctBtn.onclick = function() { onFeedback(true); };
    if (incorrectBtn) incorrectBtn.onclick = function() { onFeedback(false); };

    $('#result-save').onclick = function() {
      saveRecord({
        date: now.toISOString(), bpm: bpm, duration: duration, method: method,
        tapCount: tapCount || null,
        memo: $('#result-memo').value.trim(),
      });
      modal.classList.add('hidden');
      if (bpm >= 40) {
        showAlert('🚨 긴급 경고', '수면 호흡수 ' + bpm + '회/분',
          '즉시 동물병원에 방문하세요!\n(보리_심장병_종합분석: 40회/분 이상 = 즉시 내원)');
      }
    };
    $('#result-discard').onclick = function() { modal.classList.add('hidden'); };
  }

  // Phase 2: ML 학습 데이터 저장
  function saveMLData(bpm, method, isCorrect) {
    try {
      var stored = JSON.parse(localStorage.getItem('bori_ml_data') || '{"version":1,"samples":[]}');
      if (!stored.samples) stored.samples = [];
      stored.samples.push({
        bpm: bpm,
        method: method,
        sensitivity: $('#sensitivity').value,
        lightLevel: Math.round(analyzer._frameBrightness || 80),
        channel: (analyzer.debugInfo && analyzer.debugInfo.channel) || 'g',
        quality: analyzer.signalQuality || 0,
        correct: isCorrect,
        timestamp: Date.now()
      });
      if (stored.samples.length > 200) stored.samples = stored.samples.slice(-200);
      localStorage.setItem('bori_ml_data', JSON.stringify(stored));

      // Phase 3: TF.js 분류기 피드백 학습
      if (window.breathingClassifier && window.breathingClassifier.isReady) {
        window.breathingClassifier.addFeedback(analyzer.smoothedSignal || [], isCorrect);
        window.breathingClassifier.retrain();
      }
    } catch (e) {
      console.warn('ML 데이터 저장 오류:', e);
    }
  }

  function showAlert(title, msg, details) {
    $('#alert-title').textContent = title;
    $('#alert-message').textContent = msg;
    $('#alert-details').textContent = details || '';
    $('#alert-icon').textContent = title.indexOf('🚨')>=0?'🚨':title.indexOf('오류')>=0?'❌':'ℹ️';
    $('#alert-modal').classList.remove('hidden');
    $('#alert-close').onclick = function() { $('#alert-modal').classList.add('hidden'); };
  }


  // =============================================
  //  데이터 저장 / 기록 탭
  // =============================================
  function getRecords() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch(e) { return []; }
  }

  function saveRecord(r) {
    var records = getRecords();
    records.unshift(r);
    if (records.length > 365) records.length = 365;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    
    // 아이폰 캘린더에 자동 추가 (.ics 파일 생성)
    addToCalendar(r);
  }

  function addToCalendar(r) {
    try {
      var d = new Date(r.date);
      var status = r.bpm >= 40 ? '🚨위험' : r.bpm >= 30 ? '⚠️주의' : '✅정상';
      var method = r.method === 'manual' ? '수동 탭' : '자동 영상분석';
      
      // 날짜를 ICS 형식으로 변환 (YYYYMMDDTHHmmss)
      function icsDate(date) {
        return date.getFullYear() +
          String(date.getMonth()+1).padStart(2,'0') +
          String(date.getDate()).padStart(2,'0') + 'T' +
          String(date.getHours()).padStart(2,'0') +
          String(date.getMinutes()).padStart(2,'0') +
          String(date.getSeconds()).padStart(2,'0');
      }
      
      var endDate = new Date(d.getTime() + (r.duration || 60) * 1000);
      
      var title = '🐾 보리 호흡: ' + r.bpm + '회/분 ' + status;
      var desc = '호흡수: ' + r.bpm + '회/분\\n' +
                 '상태: ' + status + '\\n' +
                 '측정방법: ' + method + '\\n' +
                 '측정시간: ' + (r.duration || 0) + '초' +
                 (r.memo ? '\\n메모: ' + r.memo : '');
      
      var ics = 'BEGIN:VCALENDAR\r\n' +
        'VERSION:2.0\r\n' +
        'PRODID:-//Bori Breath Monitor//KO\r\n' +
        'BEGIN:VEVENT\r\n' +
        'DTSTART:' + icsDate(d) + '\r\n' +
        'DTEND:' + icsDate(endDate) + '\r\n' +
        'SUMMARY:' + title + '\r\n' +
        'DESCRIPTION:' + desc + '\r\n' +
        'END:VEVENT\r\n' +
        'END:VCALENDAR\r\n';
      
      var blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'bori_breath_' + icsDate(d) + '.ics';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) {
      console.log('Calendar export error:', e);
    }
  }

  function deleteRecord(idx) {
    var records = getRecords();
    records.splice(idx, 1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    renderHistory();
  }

  function renderHistory() {
    var records = getRecords();
    var list = $('#history-list');
    $('#total-records').textContent = records.length;

    if (!records.length) {
      list.innerHTML = '<div class="history-empty">아직 기록이 없습니다.<br>측정 탭에서 호흡수를 측정해보세요.</div>';
      $('#avg-7days').textContent = '--';
      $('#last-measurement').textContent = '--';
      drawChart([]);
      return;
    }

    $('#last-measurement').textContent = records[0].bpm;
    var week = new Date(); week.setDate(week.getDate()-7);
    var recent = records.filter(function(r) { return new Date(r.date) >= week; });
    $('#avg-7days').textContent = recent.length
      ? Math.round(recent.reduce(function(a,r) { return a+r.bpm; }, 0) / recent.length) : '--';

    list.innerHTML = '';
    records.forEach(function(r, i) {
      var d = new Date(r.date);
      var dateStr = (d.getMonth()+1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0');
      var cls = r.bpm>=40?'danger':r.bpm>=30?'warning':'';
      var bpmCls = r.bpm>=40?'danger':r.bpm>=30?'warning':'normal';
      var methodLabel = r.method==='manual'?'수동 탭':'자동 분석';
      var el = document.createElement('div');
      el.className = 'history-item ' + cls;
      el.innerHTML =
        '<div>' +
          '<div class="history-date">' + esc(dateStr) + '</div>' +
          (r.memo ? '<div class="history-memo">' + esc(r.memo) + '</div>' : '') +
          '<div class="history-method">' + methodLabel + '</div>' +
        '</div>' +
        '<div class="history-right">' +
          '<div><span class="history-bpm ' + bpmCls + '">' + r.bpm + '</span><span class="history-bpm-unit"> 회/분</span></div>' +
          '<button class="history-delete" data-idx="' + i + '">×</button>' +
        '</div>';
      list.appendChild(el);
    });

    list.querySelectorAll('.history-delete').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (confirm('이 기록을 삭제할까요?')) deleteRecord(parseInt(btn.dataset.idx));
      });
    });
    drawChart(records);
  }

  function drawChart(records) {
    var canvas = $('#history-chart');
    var ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    var w = canvas.width, h = canvas.height;
    var pad = {t:16, r:8, b:24, l:30};
    ctx.clearRect(0,0,w,h);

    if (!records.length) {
      ctx.fillStyle = '#9999b0'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('기록이 없습니다', w/2, h/2);
      return;
    }

    var data = records.slice(0,30).reverse();
    var pw = w-pad.l-pad.r, ph = h-pad.t-pad.b;
    var bpmArr = data.map(function(d){return d.bpm;});
    var maxB = Math.max.apply(null, [45].concat(bpmArr));
    var minB = Math.max(0, Math.min.apply(null, bpmArr)-5);

    [30,40].forEach(function(line) {
      var y = pad.t + ph - ((line-minB)/(maxB-minB))*ph;
      ctx.strokeStyle = line===40?'rgba(244,67,54,0.3)':'rgba(255,193,7,0.3)';
      ctx.setLineDash([3,3]); ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = line===40?'rgba(244,67,54,0.5)':'rgba(255,193,7,0.5)';
      ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(line, pad.l-4, y+3);
    });

    var pts = data.map(function(d,i) {
      return {
        x: pad.l + (data.length===1 ? pw/2 : (i/(data.length-1))*pw),
        y: pad.t + ph - ((d.bpm-minB)/(maxB-minB))*ph,
        bpm: d.bpm, date: new Date(d.date),
      };
    });

    ctx.strokeStyle = '#4a90d9'; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach(function(p,i) { i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y); });
    ctx.stroke();

    pts.forEach(function(p) {
      ctx.fillStyle = p.bpm>=40?'#f44336':p.bpm>=30?'#ffc107':'#4caf50';
      ctx.beginPath(); ctx.arc(p.x,p.y,3.5,0,Math.PI*2); ctx.fill();
    });

    ctx.fillStyle = '#9999b0'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    var step = Math.max(1, Math.floor(pts.length/5));
    for (var i=0;i<pts.length;i+=step) {
      var d = pts[i].date;
      ctx.fillText((d.getMonth()+1) + '/' + d.getDate(), pts[i].x, h-6);
    }
  }

  // CSV
  $('#btn-export').addEventListener('click', function() {
    var records = getRecords();
    if (!records.length) { showAlert('내보내기', '기록이 없습니다.'); return; }
    var csv = '\uFEFF날짜,시간,호흡수,측정방법,측정시간(초),메모\n';
    records.forEach(function(r) {
      var d = new Date(r.date);
      csv += d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ',';
      csv += String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ',';
      csv += r.bpm + ',' + (r.method==='manual'?'수동':'자동') + ',' + (r.duration||'') + ',' + (r.memo||'').replace(/,/g,' ') + '\n';
    });
    var blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '보리_호흡기록_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
  });

  $('#btn-clear-history').addEventListener('click', function() {
    if (confirm('모든 기록을 삭제하시겠습니까?')) {
      localStorage.removeItem(STORAGE_KEY);
      renderHistory();
    }
  });

  function esc(s) { var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
  renderHistory();

  // CPR 4단계 말풍선 토글
  var cprBtn = document.querySelector('#btn-cpr-steps');
  var cprTooltip = document.querySelector('#cpr-tooltip');
  var cprClose = document.querySelector('#btn-cpr-close');
  if (cprBtn && cprTooltip) {
    cprBtn.addEventListener('click', function() {
      cprTooltip.classList.toggle('hidden');
    });
    if (cprClose) {
      cprClose.addEventListener('click', function() {
        cprTooltip.classList.add('hidden');
      });
    }
  }
})();
