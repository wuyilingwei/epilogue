'use strict';
// 图形 Embedding 可选模型清单：主进程（CJS）与渲染进程（script 标签）共用。
// descKey 指向 locales 词条；unified=true 表示 onnx 为统一 model.onnx（无分离双塔，取向量需 dummy 对侧输入）。
const IMAGE_MODELS = [
  { id: 'Xenova/chinese-clip-vit-base-patch16', label: 'Chinese-CLIP ViT-B/16', size: '~190MB', descKey: 'imgm_cnclip', unified: true },
  { id: 'Xenova/clip-vit-base-patch32', label: 'OpenAI CLIP ViT-B/32', size: '~110MB', descKey: 'imgm_clip32' },
  { id: 'Xenova/clip-vit-base-patch16', label: 'OpenAI CLIP ViT-B/16', size: '~150MB', descKey: 'imgm_clip16' },
  { id: 'Xenova/clip-vit-large-patch14', label: 'OpenAI CLIP ViT-L/14', size: '~440MB', descKey: 'imgm_clipL' },
];

const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0].id;

if (typeof module !== 'undefined' && module.exports) module.exports = { IMAGE_MODELS, DEFAULT_IMAGE_MODEL };
if (typeof window !== 'undefined') window.EpilogueImageModels = { IMAGE_MODELS, DEFAULT_IMAGE_MODEL };
