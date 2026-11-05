<script setup lang="ts">
import { ref, watch } from 'vue'
import { authApi, type CaptchaChallenge } from '../vip-api'
import { tr } from '../i18n'

const props = withDefaults(defineProps<{ resetKey?: number }>(), { resetKey: 0 })

const challenge = ref<CaptchaChallenge | null>(null)
const answer = ref('')
const loading = ref(false)
const error = ref('')

async function load() {
  answer.value = ''
  error.value = ''
  try {
    challenge.value = await authApi.captcha()
  } catch {
    challenge.value = null
  }
}

/** 外部（如切换表单模式）重置时重新拉一张验证码。 */
watch(() => props.resetKey, () => { void load() }, { immediate: true })

defineExpose({
  /** 返回当前验证码答案；未启用验证码时返回 undefined。 */
  value(): { id: string; text: string } | undefined {
    if (!challenge.value?.required || !challenge.value.id) return undefined
    const text = answer.value.trim()
    if (!text) {
      error.value = tr('请输入图形验证码', 'Enter the captcha code')
      return undefined
    }
    return { id: challenge.value.id, text }
  },
  /** 校验失败后必须换一张，避免重复使用已消费的验证码。 */
  refresh() { void load() },
  get error() { return error.value },
})
</script>

<template>
  <div v-if="challenge?.required" class="captcha">
    <label for="captcha-input" class="captcha-label">{{ tr('图形验证码', 'Captcha') }}</label>
    <div class="captcha-row">
      <input
        id="captcha-input"
        v-model="answer"
        type="text"
        inputmode="text"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        maxlength="8"
        :placeholder="tr('输入图中字符', 'Type the characters')"
        @input="error = ''"
      />
      <button
        type="button"
        class="captcha-image"
        :title="tr('点击刷新验证码', 'Click to refresh')"
        :aria-label="tr('点击刷新验证码', 'Click to refresh the captcha')"
        :disabled="loading"
        @click="load"
      >
        <img v-if="challenge.svg" :src="`data:image/svg+xml;base64,${challenge.svg}`" alt="" />
      </button>
    </div>
    <p v-if="error" class="captcha-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.captcha { display: grid; gap: 6px; }
.captcha-label { font-size: 13px; color: #c4cad9; }
.captcha-row { display: flex; gap: 10px; align-items: stretch; }
.captcha-row input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 10px;
  background: #080b12;
  color: var(--fg);
  letter-spacing: 2px;
  text-transform: uppercase;
}
.captcha-image {
  flex-shrink: 0;
  width: 132px;
  padding: 0;
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 10px;
  background: #0d1017;
  overflow: hidden;
  cursor: pointer;
  line-height: 0;
}
.captcha-image img { width: 100%; height: 44px; display: block; }
.captcha-error { color: var(--accent-fg-soft); font-size: 12px; }
</style>
