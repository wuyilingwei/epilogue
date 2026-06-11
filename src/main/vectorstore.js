'use strict';
// 本地向量库（045 双文件架构 —— 避免全量加载进内存）：
//   index.json   gzip JSON 元数据（无向量；record.vecDim 标维度），常驻内存的只有这部分
//   vectors.bin  'EVB1' 魔数 + count(u32le)，每条 [idLen u16le][id utf8][dim u16le][f32le×dim]
// 向量检索时流扫 bin（scratch Float32Array 复用，零分配），扫完即弃不常驻；
// 新写入向量在 pendingVec 暂存，flush 时与旧 bin 合并重写（临时文件 + rename 原子）。
// 迁移：旧单文件（明文 number[] / gzip 'f32:'+base64 两代）load 时解出 → 标 dirty → flush 落双文件。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const VEC_PREFIX = 'f32:';
const BIN_MAGIC = Buffer.from('EVB1');

function toF32(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return Float32Array.from(v);
  if (typeof v === 'string' && v.startsWith(VEC_PREFIX)) {
    const buf = Buffer.from(v.slice(VEC_PREFIX.length), 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  return null;
}

function hasVec(r) {
  return (r.vecDim || 0) > 0;
}

class VectorStore {
  constructor(file) {
    this.file = file;
    this.vecFile = path.join(path.dirname(file), 'vectors.bin');
    this.records = [];
    this.pendingVec = new Map(); // id -> Float32Array（新写入/迁移暂存，flush 后清）
    try {
      const buf = fs.readFileSync(file);
      const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      this.records = JSON.parse(text);
      let migrated = false;
      for (const r of this.records) {
        if (r.vector != null) {
          // 旧单文件格式：向量内嵌 —— 解出暂存，flush 时落 bin
          const f = toF32(r.vector);
          if (f) {
            this.pendingVec.set(r.id, f);
            r.vecDim = f.length;
          }
          delete r.vector;
          migrated = true;
        }
      }
      if (migrated) this.save();
    } catch {
      /* 首次运行 */
    }
  }

  // 写盘防抖：批量索引时合并为少量全量写；退出前由 flush() 兜底落盘
  save() {
    this.dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 200);
    this._saveTimer.unref?.();
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 元数据（gzip level 1：速度优先）
    fs.writeFileSync(this.file, zlib.gzipSync(Buffer.from(JSON.stringify(this.records)), { level: 1 }));
    this._rewriteBin();
  }

  // 合并重写 vectors.bin：旧 bin 中仍存活且未被更新的条目原样拷贝 + pendingVec 追加
  _rewriteBin() {
    const alive = new Set(this.records.filter(hasVec).map((r) => r.id));
    const chunks = [];
    let count = 0;
    this._scanBin((id, dim, vecBuf) => {
      if (!alive.has(id) || this.pendingVec.has(id)) return;
      const idBuf = Buffer.from(id, 'utf8');
      const head = Buffer.alloc(2 + idBuf.length + 2);
      head.writeUInt16LE(idBuf.length, 0);
      idBuf.copy(head, 2);
      head.writeUInt16LE(dim, 2 + idBuf.length);
      chunks.push(head, Buffer.from(vecBuf)); // 拷贝（vecBuf 是大 buffer 的视图）
      count++;
    });
    for (const [id, f] of this.pendingVec) {
      if (!alive.has(id)) continue;
      const idBuf = Buffer.from(id, 'utf8');
      const head = Buffer.alloc(2 + idBuf.length + 2);
      head.writeUInt16LE(idBuf.length, 0);
      idBuf.copy(head, 2);
      head.writeUInt16LE(f.length, 2 + idBuf.length);
      chunks.push(head, Buffer.from(f.buffer, f.byteOffset, f.byteLength));
      count++;
    }
    const header = Buffer.alloc(8);
    BIN_MAGIC.copy(header, 0);
    header.writeUInt32LE(count, 4);
    const tmp = `${this.vecFile}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([header, ...chunks]));
    fs.renameSync(tmp, this.vecFile); // 原子替换
    this.pendingVec.clear();
  }

  // 顺序扫描 bin：cb(id, dim, vecBuf 视图)；文件缺失/损坏时静默空扫
  _scanBin(cb) {
    let buf;
    try {
      buf = fs.readFileSync(this.vecFile);
    } catch {
      return;
    }
    if (buf.length < 8 || !buf.subarray(0, 4).equals(BIN_MAGIC)) return;
    const count = buf.readUInt32LE(4);
    let off = 8;
    for (let i = 0; i < count && off + 4 <= buf.length; i++) {
      const idLen = buf.readUInt16LE(off);
      off += 2;
      const id = buf.toString('utf8', off, off + idLen);
      off += idLen;
      const dim = buf.readUInt16LE(off);
      off += 2;
      const byteLen = dim * 4;
      if (off + byteLen > buf.length) return; // 截断防护
      cb(id, dim, buf.subarray(off, off + byteLen));
      off += byteLen;
    }
  }

  upsert(record) {
    const i = this.records.findIndex((r) => r.filePath === record.filePath);
    const withId = { id: i >= 0 ? this.records[i].id : `f_${this.records.length}_${record.fileName}`, ...record };
    const f = withId.vector != null ? toF32(withId.vector) : null;
    delete withId.vector; // 向量不驻留 records
    if (f) {
      this.pendingVec.set(withId.id, f);
      withId.vecDim = f.length;
    }
    if (i >= 0) this.records[i] = withId;
    else this.records.push(withId);
    this.save();
    return withId;
  }

  remove(filePath) {
    const r = this.records.find((x) => x.filePath === filePath);
    if (r) this.pendingVec.delete(r.id);
    this.records = this.records.filter((x) => x.filePath !== filePath);
    this.save();
  }

  // 文件被归类移动后更新路径
  updatePath(oldPath, newPath) {
    const r = this.records.find((x) => x.filePath === oldPath);
    if (r) {
      r.filePath = newPath;
      r.fileName = path.basename(newPath);
      this.save();
    }
  }

  get(filePath) {
    return this.records.find((r) => r.filePath === filePath);
  }

  all() {
    return this.records;
  }

  stats() {
    return { total: this.records.length, withVector: this.records.filter(hasVec).length };
  }

  // 按文件类型统计：条数 + 字节估算（元数据 JSON 长度 + 向量 dim×4）
  kindStats() {
    const out = {};
    for (const r of this.records) {
      const k = r.kind || 'other';
      if (!out[k]) out[k] = { count: 0, bytes: 0 };
      out[k].count++;
      out[k].bytes += JSON.stringify(r).length + (r.vecDim || 0) * 4;
    }
    return out;
  }

  // 删除某类全部索引记录（不动原文件，重新索引可恢复），返回删除条数
  removeKind(kind) {
    const before = this.records.length;
    const gone = this.records.filter((r) => (r.kind || 'other') === kind);
    for (const r of gone) this.pendingVec.delete(r.id);
    this.records = this.records.filter((r) => (r.kind || 'other') !== kind);
    this.save();
    return before - this.records.length;
  }

  static cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  // 向量检索：流扫 bin + pendingVec，scratch 复用零分配；向量扫完即弃不常驻
  searchByVector(queryVector, topK = 8) {
    const q = toF32(queryVector);
    if (!q) return [];
    const byId = new Map(this.records.map((r) => [r.id, r]));
    const hits = [];
    const consider = (record, score) => {
      hits.push({ record, score });
      if (hits.length > topK * 4) {
        hits.sort((a, b) => b.score - a.score);
        hits.length = topK;
      }
    };
    const scratch = new Float32Array(4096);
    this._scanBin((id, dim, vecBuf) => {
      if (dim !== q.length || this.pendingVec.has(id)) return;
      const record = byId.get(id);
      if (!record) return;
      const view = new Float32Array(scratch.buffer, 0, dim);
      Buffer.from(view.buffer, 0, dim * 4).set(vecBuf); // 对齐复制到 scratch
      consider(record, VectorStore.cosine(q, view));
    });
    for (const [id, f] of this.pendingVec) {
      const record = byId.get(id);
      if (record && f.length === q.length) consider(record, VectorStore.cosine(q, f));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  static tokenize(text) {
    // 中英混合：英文按词、中文按双字滑窗
    const tokens = new Set();
    for (const m of (text || '').toLowerCase().matchAll(/[a-z0-9]+|[一-鿿]+/g)) {
      const seg = m[0];
      if (/^[a-z0-9]+$/.test(seg)) {
        tokens.add(seg);
      } else {
        for (let i = 0; i < seg.length; i++) {
          tokens.add(seg[i]);
          if (i + 1 < seg.length) tokens.add(seg.slice(i, i + 2));
        }
      }
    }
    return tokens;
  }

  searchByKeywords(query, topK = 8) {
    const q = VectorStore.tokenize(query);
    if (!q.size) return [];
    return this.records
      .map((r) => {
        // filePath 入 hay：文件夹名（如「回归线」）也参与关键词召回，对存量索引立即生效
        const hay = VectorStore.tokenize(`${r.filePath} ${r.fileName} ${(r.keywords || []).join(' ')} ${r.summary || ''}`);
        let hit = 0;
        for (const t of q) if (hay.has(t)) hit++;
        return { record: r, score: hit / q.size };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

module.exports = { VectorStore, hasVec, toF32 };
