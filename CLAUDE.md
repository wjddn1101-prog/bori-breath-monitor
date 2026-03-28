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
| `sw.js` | Service Worker (PWA 오프라인) |

## 작업 규칙

### 코드 작성
- 기존 패턴과 일관성 유지 (vanilla JS, no bundler)
- OpenCV.js Mat 객체는 반드시 `.delete()` 호출
- Web Worker 통신은 `postMessage` / `onmessage` 패턴 유지
- 새 기능은 기존 알고리즘을 망가뜨리지 않도록 점진적 추가

### 응답 스타일
- 한국어로 응답
- 코드 변경 시 변경 이유 간략히 설명
- 불필요한 리팩토링이나 주석 추가 금지

### 현재 알고리즘 버전
- v6: ROI 평균 밝기 분석 (Optical Flow → 밝기 기반으로 전환)
- Phase 1: 3×3 그리드 ROI 자동 탐지
- Phase 2: 피드백 기반 적응 학습 (bori_ml_data)
- Phase 3: TF.js Dense 분류기 (ml-classifier.js)

## 브라우저 지원 타깃
iOS Safari 15+, Chrome/Android 90+
HTTPS 필수 (카메라 API)
