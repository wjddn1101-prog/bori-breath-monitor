import { createWidget, widget, prop } from '@zos/ui'
import { startRespirationMonitor } from '../utils/sensor'

Page({
  build() {
    createWidget(widget.TEXT, {
      x: 0,
      y: 80, // 상단 마진
      w: 480, // 밸런스2 화면 너비
      h: 60,
      color: 0xffffff,
      text_size: 30,
      align_h: 0,
      text: '   Bori Breath'
    })

    const bpmText = createWidget(widget.TEXT, {
      x: 0,
      y: 160,
      w: 480,
      h: 100,
      color: 0x00ff00, // 초록색 하이라이트
      text_size: 60,
      align_h: 0,
      text: '   -- BPM'
    })

    const hrText = createWidget(widget.TEXT, {
      x: 0,
      y: 280,
      w: 480,
      h: 50,
      color: 0xffaa00, // 주황색
      text_size: 28,
      align_h: 0,
      text: '   HR(Exp): --'
    })

    const rawText = createWidget(widget.TEXT, {
      x: 0,
      y: 350,
      w: 480,
      h: 40,
      color: 0xaaaaaa, // 회색
      text_size: 24,
      align_h: 0,
      text: '   Raw Sensor: 0'
    })

    // 센서 가동 및 UI 업데이트 콜백
    this.sensor = startRespirationMonitor((data) => {
      bpmText.setProperty(prop.MORE, { text: `   ${data.srr} BPM` })
      hrText.setProperty(prop.MORE, { text: `   HR(Exp): ${Math.round(data.hr)}` })
      rawText.setProperty(prop.MORE, { text: `   Raw Sensor: ${Math.round(data.raw)}` })
    })
  },
  
  onDestroy() {
    // 앱 종료 시 배터리를 위해 센서 무조건 끄기
    if (this.sensor) {
      this.sensor.stop()
    }
  }
})
