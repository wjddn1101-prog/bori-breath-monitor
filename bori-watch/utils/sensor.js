import { Accelerometer } from '@zos/sensor'

export function startRespirationMonitor(onUpdate) {
  const accel = new Accelerometer()
  let history = []
  
  accel.onChange(() => {
    const { x, y, z } = accel.getCurrent()
    // 간소화된 3차원 움직임 크기
    const magnitude = Math.abs(x) + Math.abs(y) + Math.abs(z)
    
    history.push({ time: Date.now(), val: magnitude })
    
    // 최근 15초 데이터만 보존
    const cutoff = Date.now() - 15000
    history = history.filter(d => d.time > cutoff)
    
    if (history.length > 30) {
      // 1. 호흡수 (SRR) - 부드럽고 느린 파동 감지
      let smoothed = []
      for (let i = 2; i < history.length - 2; i++) {
        let avg = (history[i-2].val + history[i-1].val + history[i].val + history[i+1].val + history[i+2].val) / 5
        smoothed.push(avg)
      }
      
      let srrPeaks = 0
      for (let i = 1; i < smoothed.length - 1; i++) {
        // 호흡으로 간주할 만큼의 진폭(50 이상)이 있는지 검사
        if (smoothed[i] > smoothed[i-1] && smoothed[i] > smoothed[i+1] && Math.abs(smoothed[i] - smoothed[i-1]) > 50) {
           srrPeaks++
        }
      }
      const srrBpm = srrPeaks * 4 // 15초 데이터를 60초(1분)으로 환산
      
      // 2. 실험적 심지진도 (BCG/HR) - 작고 빠른 진동(심박 타격)
      let hrPeaks = 0
      for (let i = 1; i < history.length - 1; i++) {
         const diff = Math.abs(history[i].val - history[i-1].val)
         // 호흡 파동 보다는 작지만 노이즈보다는 큰 10~40 사이의 충격 감지
         if (diff > 10 && diff < 40) { 
            hrPeaks++
         }
      }
      // 1분 환산 및 비정상적 최대치(180 이상) 제한 필터
      const hrBpm = Math.min((hrPeaks / 2) * 4, 180) 
      
      onUpdate({ srr: srrBpm, hr: hrBpm, raw: magnitude })
    }
  })
  
  accel.start()
  return accel
}
