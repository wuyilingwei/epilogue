'use strict';
// 模型下载进度聚合：@huggingface/transformers 的 progress_callback 按「单个文件」回调
// （onnx/tokenizer/config 多文件并行下载，各自 percent 0→100），直接转发会让进度条来回闪。
//
// 诚实百分比语义：各文件的 total 只在其首个 'progress' 事件携带 —— 小文件先完成时若按
// Σloaded/Σtotal 计算会瞬间≈100%（大文件 total 还未计入）。因此跟踪 'initiate'（文件已开始
// 但 total 未知）：只要存在 pending 文件，percent 为 null（未知，UI 显示字节+流动条）；
// 全部文件 total 已知后才给出真实百分比，此后 loaded 单增、total 固定，天然单调。
// 纯函数、零依赖：modelHost 子进程与 /test 共用。

function createAggregator() {
  const byModel = new Map(); // model -> { files: Map<file,{loaded,total}>, pending: Set<file> }

  function entry(model) {
    let m = byModel.get(model);
    if (!m) byModel.set(model, (m = { files: new Map(), pending: new Set() }));
    return m;
  }

  function sums(m) {
    let loaded = 0;
    let total = 0;
    for (const f of m.files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    return { loaded, total };
  }

  return {
    // 'initiate'：文件开始下载但 total 未知 → 百分比进入「未知」状态
    initiate(model, file) {
      const m = entry(model);
      if (!m.files.has(file || '?')) m.pending.add(file || '?');
    },

    // 'progress'：携带该文件 loaded/total → 返回聚合进度（percent 为 null 表示尚有文件 total 未知）
    update(model, { file, loaded = 0, total = 0 }) {
      const m = entry(model);
      const key = file || '?';
      m.pending.delete(key);
      m.files.set(key, { loaded, total });
      const s = sums(m);
      const known = !m.pending.size && s.total > 0;
      // 封顶 99：100 只在 done() 时给
      return { model, percent: known ? Math.min(99, Math.floor((s.loaded / s.total) * 100)) : null, loaded: s.loaded, total: known ? s.total : 0 };
    },

    // 下载结束（成功）：上报 100 并清理状态；纯缓存加载（无任何进度）时 total=0，调用方据此跳过上报
    done(model) {
      const m = byModel.get(model);
      byModel.delete(model);
      const s = m ? sums(m) : { loaded: 0, total: 0 };
      return { model, percent: 100, loaded: s.loaded, total: s.total };
    },

    // 下载失败/中止：清理状态，重试时从头聚合
    clear(model) {
      byModel.delete(model);
    },
  };
}

module.exports = { createAggregator };
