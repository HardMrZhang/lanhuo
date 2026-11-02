import { computed, ref, watch } from 'vue'

export type Locale = 'zh-CN' | 'en'
const STORAGE_KEY = 'duanju:locale'

function savedLocale(): Locale {
  try { return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh-CN' }
  catch { return 'zh-CN' }
}

export const locale = ref<Locale>(savedLocale())
export const localeTag = computed(() => locale.value === 'en' ? 'en-US' : 'zh-CN')
export const tr = (zh: string, en: string) => locale.value === 'en' ? en : zh

export function setLocale(value: Locale) {
  if (value === 'en' || value === 'zh-CN') locale.value = value
}

watch(locale, (value) => {
  try { localStorage.setItem(STORAGE_KEY, value) } catch { /* Browsing still works without storage. */ }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = value
    document.querySelector('meta[name="description"]')?.setAttribute('content', tr(
      '短剧剧场：精选都市、甜宠、古装、悬疑与漫剧内容。',
      'Drama Theater: discover short dramas, romance, period stories, mysteries and animation.',
    ))
  }
}, { immediate: true, flush: 'sync' })

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) setLocale(event.newValue === 'en' ? 'en' : 'zh-CN')
  })
}

const categories: Record<string, string> = {
  全部: 'All', 全部短剧: 'All Dramas', 精选: 'Featured',
  成人短剧: 'Adult Shorts', 欧美短剧: 'Western Shorts', 成人漫剧: 'Adult Animation', 真人剧: 'Live Action',
  成人视频: 'Adult Videos', 成人小说: 'Adult Fiction',
  都市: 'Urban', 甜宠: 'Romance', 古装: 'Period', 悬疑: 'Mystery',
  逆袭: 'Comeback', 漫剧: 'Animation', 玄幻: 'Fantasy', 家庭: 'Family',
}
export const translateCategory = (name: string) => locale.value === 'en' ? categories[name] ?? name : name

const plans: Record<string, string> = {
  月度会员: 'Monthly Pass', 月卡: 'Monthly Pass', 季度会员: 'Quarterly Pass',
  半年会员: '6-Month Pass', 半年卡: '6-Month Pass', 年度会员: 'Annual Pass', 年卡: 'Annual Pass',
}
export const translatePlanName = (name: string) => locale.value === 'en' ? plans[name] ?? name : name

// Preserve canonical server messages in state; translate when rendering so even
// an existing error changes language without repeating the failed request.
const messages: Record<string, string> = {
  '请求失败，请稍后重试。': 'The request failed. Please try again later.',
  '服务暂时不可用，请稍后重试。': 'The service is unavailable. Please try again later.',
  '服务暂时不可用，请稍后再试': 'The service is unavailable. Please try again later.',
  '请求超时，请重试；重复尝试不会重复创建同一笔订单。': 'The request timed out. Retry to check the same order; it will not create a duplicate.',
  '网络连接失败，请检查网络后重试。': 'Connection failed. Check your network and try again.',
  '无法加载账号，请重试。': 'Unable to load your account. Please try again.',
  '登录失败，请重试。': 'Unable to sign in. Please try again.',
  '退出失败，请重试。': 'Unable to sign out. Please try again.',
  '复制失败，请选中下方地址或金额后手动复制。': 'Could not copy. Select the address or amount below and copy it manually.',
  '复制失败，请选中上方地址后手动复制。': 'Could not copy. Select the address above and copy it manually.',
  '复制失败，请手动复制浏览器地址': 'Could not copy. Please copy the address from your browser.',
  '链接已复制': 'Link copied',
  '加载失败，请稍后重试': 'Unable to load. Please try again later.',
  '操作过于频繁，请稍后再试': 'Too many attempts. Please try again later.',
  '请先登录': 'Please sign in first.',
  '不允许跨站请求': 'This request was blocked. Open the site directly and try again.',
  '请使用 JSON 请求': 'Invalid request format. Please refresh the page and try again.',
  '请输入有效邮箱及 8–128 位密码': 'Enter a valid email and a password with 8–128 characters.',
  '该邮箱已注册，请登录': 'This email is already registered. Please sign in.',
  '邮箱或密码错误': 'Incorrect email or password.',
  '缺少有效的 Idempotency-Key': 'The checkout request is invalid. Please refresh and try again.',
  '同一请求编号不能用于不同套餐': 'This request belongs to another plan. Please refresh and try again.',
  '会员套餐不存在': 'This membership plan is no longer available.',
  '请选择支付通道': 'Please choose a payment channel.',
  '支付通道不可用': 'This payment channel is unavailable.',
  '同一请求编号不能用于不同支付通道': 'This request belongs to another payment channel. Please refresh and try again.',
  'VaeHub 支付暂未开放，请稍后再试': 'VaeHub payments are currently unavailable. Please try again later.',
  '加密货币支付暂未开放，请稍后再试': 'Crypto payments are currently unavailable. Please try again later.',
  '暂时无法创建支付订单，请在订单记录中查看状态': 'Unable to create the payment. Check your order history for its status.',
  '支付订单创建结果待核实，请勿重复付款': 'Your payment order needs verification. Please do not pay again.',
  '订单不存在': 'Order not found.',
  '订单正在同步，请重试': 'Your order is being updated. Please try again.',
  '订单支付信息不匹配': 'The payment does not match this order.',
  '支付编号不匹配': 'The payment reference does not match.',
  '请求内容过大': 'The request is too large.',
  '无效的 JSON 请求': 'Invalid request. Please refresh and try again.',
  '该剧暂无剧集': 'No episodes are available for this drama yet.',
  '该集为 VIP 专享，请先开通会员': 'This episode is for VIP members. Join VIP to watch it.',
  '无效的媒体路径': 'Invalid media path.',
  '该集暂无可用视频地址，请稍后重试。': 'This episode is not available yet. Please try again later.',
  '当前浏览器无法播放此格式的视频。': 'Your browser cannot play this video format.',
  '视频加载失败，请检查网络后重试。': 'Could not load the video. Check your network and try again.',
  '视频暂时无法播放，请重试或选择其他集数。': 'This video is unavailable. Retry or choose another episode.',
  '视频源不可用或格式不受支持，请重试或选择其他集数。': 'The video source is unavailable or unsupported. Retry or choose another episode.',
  '这部剧集暂时无法找到，去首页发现更多精彩故事。': 'This drama could not be found. Visit the home page to discover more stories.',
  '剧集加载失败，请检查网络后重试。': 'Could not load this drama. Check your network and try again.',
}

export function translateMessage(message: string) {
  if (locale.value === 'zh-CN') return message
  return messages[message] ?? (/\p{Script=Han}/u.test(message) ? 'Something went wrong. Please try again.' : message)
}
