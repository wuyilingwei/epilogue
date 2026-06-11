'use strict';
// 计费网络状态：桌面端无可靠系统 API，采用渲染层 navigator.connection 上报的 best-effort 方案。
// 窗口未开（托盘 only）期间维持最后一次上报值，默认按非计费处理。
let metered = false;

function setMetered(v) {
  metered = Boolean(v);
}

function isMetered() {
  return metered;
}

module.exports = { setMetered, isMetered };
