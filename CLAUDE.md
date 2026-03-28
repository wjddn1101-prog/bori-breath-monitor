# CLAUDE.md — 보리 호흡 모니터

## 프로젝트 개요
보리(강아지)의 호흡수를 카메라 영상으로 측정하는 PWA 앱.
순수 클라이언트 사이드 — 서버 없음, localStorage 저장.

## 핵심 파일
| 파일 | 역할 |
|------|------|
| `breathing-analyzer.js` | 호흡 감지 알고리즘 (ROI 스캔, 밴드패스, 칼만) |
| `analysis-worker.js` | Web Worker — FFT/자기상관/피크 3중 교차검증 |
| `app.js` | UI 상태 관리, 카메라, 결과 모달 |
| `ml-classifier.js` | TF.js 신호 품질 분류기 |
| `index.html` | HTML 구조 |
| `style.css` | 글래스모피즘 UI |
| `sw.js` | Service Worker (PWA 오프라인, 캐시 버전 v7) |

## 현재 브랜치
`claude/sync-github-updates-UnriZ`

## 최근 작업 이력 (2026-03-28)

### ML 기반 정확도 개선 (커밋 0e86fa4)
**Phase 1 — 스마트 ROI 자동 탐지**
- `breathing-analyzer.js`에 `_initCandidateROIs()`, `_extractROIGreen()`, `_scoreROISignal()`, `_finalizeScan()` 추가
- 측정 시작 후 5초간 3×3 그리드(9개 ROI) 밝기 수집 → 호흡 에너지 최고 영역 자동 선택
- `setROI(roi, userSet)` — 사용자 수동 지정 시 스캔 생략
- `app.js`: `onRoiFound` 콜백, `#roi-scan-status` 오버레이 표시

**Phase 2 — 피드백 기반 적응 학습**
- 결과 모달에 "맞아요 / 틀렸어요" 버튼 추가
- 성공 측정 컨텍스트를 `bori_ml_data` (localStorage)에 저장
- `loadAdaptiveParams(lightLevel)` — 유사 조도 환경에서 성공 파라미터 자동 적용
- 3회 이상 누적 시 "🐾 보리 맞춤 모드" 배지 표시

**Phase 3 — TF.js 신호 품질 분류기**
- `ml-classifier.js` 신규 생성: Dense(32→16→1) 네트워크
- 합성 데이터(사인파·노이즈·드리프트·고주파 진동)로 사전 학습 (25 에폭)
- 피드백 누적 시 브라우저 내 재학습, IndexedDB 저장
- 분류기 신뢰도 < 35% → BPM 억제
- `window._analyzerInstance`로 analyzer 노출 → 분류기 자동 주입

### Claude Code 설정 추가 (커밋 0171114)
- `.claude/settings.json`: model=sonnet, permissions, SessionStart hook
- `CLAUDE.md` 생성

### 알고리즘 설명 탭 업데이트 (커밋 55c0823)
- `index.html`: SRR v5 → SRR v6 + ML 설명으로 전면 업데이트

## 다음 작업 후보
- 실제 보리 영상으로 ML 정확도 테스트
- 피드백 3회 이상 누적 후 "보리 맞춤 모드" 동작 확인
- 필요 시 TF.js 모델 파라미터 튜닝

## 코드 작업 규칙
- 기존 패턴과 일관성 유지 (vanilla JS, no bundler)
- OpenCV.js Mat 객체는 반드시 `.delete()` 호출
- Web Worker 통신은 `postMessage` / `onmessage` 패턴 유지
- 새 기능은 기존 알고리즘을 망가뜨리지 않도록 점진적 추가
- 한국어로 응답
- 불필요한 리팩토링이나 주석 추가 금지

## 브라우저 지원 타깃
iOS Safari 15+, Chrome/Android 90+, HTTPS 필수
