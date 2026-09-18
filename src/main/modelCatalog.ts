// whisper.cpp 模型目录（HuggingFace 直链，resolve/main 会 302 到 CDN）
import type { ModelInfo } from '@shared/types'
import { tm } from './i18n'

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: 'turbo-q5',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    url: `${HF}/ggml-large-v3-turbo-q5_0.bin`,
    sizeLabel: 'model.turboQ5.size',
    langs: 'model.turboQ5.langs',
    desc: 'model.turboQ5.desc'
  },
  {
    id: 'turbo-q8',
    file: 'ggml-large-v3-turbo-q8_0.bin',
    url: `${HF}/ggml-large-v3-turbo-q8_0.bin`,
    sizeLabel: 'model.turboQ8.size',
    langs: 'model.turboQ8.langs',
    desc: 'model.turboQ8.desc'
  },
  {
    id: 'small-en-q5',
    file: 'ggml-small.en-q5_1.bin',
    url: `${HF}/ggml-small.en-q5_1.bin`,
    sizeLabel: 'model.smallEn.size',
    langs: 'model.smallEn.langs',
    desc: 'model.smallEn.desc'
  },
  {
    id: 'base-en',
    file: 'ggml-base.en.bin',
    url: `${HF}/ggml-base.en.bin`,
    sizeLabel: 'model.baseEn.size',
    langs: 'model.baseEn.langs',
    desc: 'model.baseEn.desc'
  }
]

export function findModel(file: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.file === file)
}

/** 目录里存的是文案 key，返回给界面前按当前语言翻译（语言切换即时生效） */
export function localizeModel(m: ModelInfo): ModelInfo {
  return { ...m, sizeLabel: tm(m.sizeLabel), langs: tm(m.langs), desc: tm(m.desc) }
}
