<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import SiteHeader from '../components/SiteHeader.vue'
import SiteFooter from '../components/SiteFooter.vue'
import AccountPanel from '../components/AccountPanel.vue'
import { account, refreshAccount, updateAccount } from '../account'
import { AccountApiError, vipApi, type VipCatalog, type VipOrder } from '../vip-api'
import { localeTag, tr, translateMessage, translatePlanName } from '../i18n'

const route = useRoute()
const catalog = ref<VipCatalog | null>(null)
const catalogLoading = ref(true)
const catalogError = ref('')
const selectedId = ref('')
const selectedPlan = computed(() => catalog.value?.plans.find((plan) => plan.id === selectedId.value))
const orders = ref<VipOrder[]>([])
const ordersLoading = ref(false)
const ordersError = ref('')
const paymentError = ref('')
const paymentBusy = ref(false)
const orderBusy = ref(false)
const currentOrder = ref<VipOrder | null>(null)
const orderError = ref('')
const copiedField = ref('')
const copyError = ref('')
const returnOrderId = typeof route.query.order === 'string' ? route.query.order : ''
const currentOrderId = ref(returnOrderId)
const returnedFromPayment = Boolean(returnOrderId || route.query.payment)
const selectedProvider = ref<'nowpayments' | 'vaehub' | ''>('')
let active = true
let userEpoch = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
const requestKeys = new Map<string, string>()

const providerName = (id: string) => id === 'vaehub' ? 'VaeHub' : id === 'nowpayments' ? 'NOWPayments' : id
const providerNames = computed(() => (catalog.value?.payment.providers || []).map((item) => providerName(item.id)).join(' / '))
const statusLabels = computed<Record<string, string>>(() => ({
  creating: tr('订单创建中', 'Creating order'), pending: tr('等待支付', 'Awaiting payment'), confirming: tr('支付确认中', 'Confirming payment'),
  partially_paid: tr('待补足金额', 'Underpaid'), paid: tr('支付成功', 'Payment confirmed'), failed: tr('支付失败', 'Payment failed'),
  expired: tr('订单已过期', 'Order expired'), refunded: tr('已退款', 'Refunded'), review: tr('等待人工核实', 'Under review'),
}))
const statusDescriptions = computed<Record<string, string>>(() => ({
  creating: tr('正在准备支付订单，请稍后刷新。', 'Your payment order is being prepared. Please refresh shortly.'),
  pending: tr('请通过 TRON（TRC20）网络向下方地址转入指定金额的 USDT。到账确认后，会员时长会自动更新。', 'Send the exact USDT amount to the address below using TRON (TRC20). Your membership will update automatically after payment is confirmed.'),
  confirming: tr('已收到支付信息，正在等待区块链确认，请勿重复付款。', 'Your payment has been detected and is awaiting blockchain confirmation. Please do not pay again.'),
  partially_paid: tr('当前到账金额不足，请保留交易哈希和订单号以便核实。暂勿按原总额再次转账。', 'The amount received is less than required. Keep your transaction hash and order number for review. Do not send the full original amount again.'),
  paid: tr('付款已确认，会员时长已计入当前账号。', 'Payment confirmed. Your membership time has been added to this account.'),
  failed: tr('本次支付未成功。若钱包已扣款，请保留交易哈希与订单号以便核实。', 'This payment was unsuccessful. If funds left your wallet, keep your transaction hash and order number for review.'),
  expired: tr('此订单已过期，请勿继续转账。你可以重新选择套餐。', 'This order has expired. Do not send any funds. You can choose a plan to start a new order.'),
  refunded: tr('此订单已退款，会员时长调整需进一步核实，当前状态以账号显示为准。', 'This order has been refunded. Membership adjustments are under review; refer to the status shown in your account.'),
  review: tr('这笔支付需要进一步核实，请保留订单号与交易哈希，暂勿重复支付。', 'This payment needs further review. Keep your order number and transaction hash, and do not pay again.'),
}))
const currentDescription = computed(() => {
  const order = currentOrder.value
  if (!order) return ''
  if (order.status === 'pending') {
    if (order.expiresAt && Date.parse(order.expiresAt) <= Date.now()) return tr('此支付地址已超过有效时间，请勿继续转账。已转账的订单请等待确认；未支付可重新选择套餐。', 'This payment address has expired. Do not send funds. If you already paid, wait for confirmation; otherwise, choose a plan to start again.')
    if (!canContinue(order)) return tr('支付地址暂不可用，请刷新订单后再试，暂勿转账。', 'The payment address is currently unavailable. Refresh the order and try again. Do not send funds yet.')
  }
  return statusDescriptions.value[order.status] || tr('支付结果仍在核实，请稍后刷新。', 'Your payment is still being verified. Please refresh shortly.')
})
const canPay = computed(() => Boolean(account.user && account.status === 'ready' && catalog.value?.payment.enabled && selectedPlan.value && selectedProvider.value && !paymentBusy.value))
const currencyText = computed(() => `${catalog.value?.payment.currencies.join(' / ') || 'USDT'} · ${(catalog.value?.payment.providers || []).map((item) => providerName(item.id)).join(' / ') || catalog.value?.payment.network || ''}`)

function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(localeTag.value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
function price(value: number) { return value.toLocaleString(localeTag.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function message(error: unknown) { return error instanceof Error ? error.message : '请求失败，请稍后重试。' }
function isPending(order: VipOrder) { return ['creating', 'pending', 'confirming', 'partially_paid'].includes(order.status) }
function vaehubActive(order: VipOrder) { return order.provider === 'vaehub' }
function canOpenCashier(order: VipOrder) { return vaehubActive(order) && Boolean(order.checkoutUrl) && ['pending', 'confirming'].includes(order.status) }
// NOWPayments 订单靠转账地址继续；VaeHub 订单跳转收银台继续（qrcode 模式展示二维码串）。
function canContinue(order: VipOrder) {
  if (vaehubActive(order)) return canOpenCashier(order)
  return Boolean(order.payAddress && order.payAmount && order.status === 'pending' && (!order.expiresAt || Date.parse(order.expiresAt) > Date.now()))
}
function stopPolling() { clearTimeout(pollTimer); pollTimer = undefined }
function handleAuthError(error: unknown) {
  if (error instanceof AccountApiError && error.status === 401) updateAccount(null)
}

async function loadCatalog() {
  catalogLoading.value = true
  catalogError.value = ''
  try {
    const data = await vipApi.plans()
    if (!active) return
    catalog.value = data
    selectedId.value = data.plans.find((plan) => plan.recommended)?.id || data.plans[0]?.id || ''
    const ids = (data.payment.providers || []).map((item) => item.id)
    if (!ids.includes(selectedProvider.value as 'nowpayments' | 'vaehub')) selectedProvider.value = ids[0] ?? ''
  } catch (error) { if (active) catalogError.value = message(error) }
  finally { if (active) catalogLoading.value = false }
}

async function loadOrders() {
  if (!account.user || ordersLoading.value) return
  const epoch = userEpoch
  ordersLoading.value = true
  ordersError.value = ''
  try {
    const result = await vipApi.orders()
    if (!active || epoch !== userEpoch) return
    orders.value = result.orders
    if (!currentOrderId.value) {
      const unfinished = result.orders.find(isPending)
      if (unfinished) { currentOrderId.value = unfinished.id; currentOrder.value = unfinished; schedulePoll() }
    }
  } catch (error) {
    if (!active || epoch !== userEpoch) return
    ordersError.value = message(error)
    handleAuthError(error)
  } finally { if (active && epoch === userEpoch) ordersLoading.value = false }
}

function schedulePoll() {
  stopPolling()
  if (active && !document.hidden && account.user && currentOrder.value && isPending(currentOrder.value)) {
    pollTimer = setTimeout(() => { void refreshOrder() }, 5000)
  }
}

async function refreshOrder() {
  if (!account.user || !currentOrderId.value || orderBusy.value) return
  const epoch = userEpoch
  const orderId = currentOrderId.value
  orderBusy.value = true
  orderError.value = ''
  stopPolling()
  try {
    const result = await vipApi.order(orderId)
    if (!active || epoch !== userEpoch || orderId !== currentOrderId.value) return
    currentOrder.value = result.order
    updateAccount(result.user)
    const index = orders.value.findIndex((order) => order.id === result.order.id)
    if (index >= 0) orders.value[index] = result.order
    else orders.value.unshift(result.order)
  } catch (error) {
    if (!active || epoch !== userEpoch || orderId !== currentOrderId.value) return
    orderError.value = message(error)
    handleAuthError(error)
  } finally {
    if (active && epoch === userEpoch && orderId === currentOrderId.value) {
      orderBusy.value = false
      if (!orderError.value) schedulePoll()
    }
  }
}

function keyFor(planId: string) {
  const storageKey = `vip-checkout:${account.user!.id}:${planId}`
  let key = requestKeys.get(storageKey)
  try { key ||= sessionStorage.getItem(storageKey) || undefined } catch { /* Memory fallback when storage is unavailable. */ }
  if (!key) {
    if (typeof crypto.randomUUID === 'function') key = crypto.randomUUID()
    else {
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 15) | 64
      bytes[8] = (bytes[8] & 63) | 128
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
    requestKeys.set(storageKey, key)
    try { sessionStorage.setItem(storageKey, key) } catch { /* The in-memory key still protects retries. */ }
  }
  return { key, storageKey }
}

async function copyPayment(value: string, field: string) {
  copyError.value = ''
  try {
    await navigator.clipboard.writeText(value)
    copiedField.value = field
  } catch {
    copyError.value = '复制失败，请选中下方地址或金额后手动复制。'
  }
}

async function createOrder() {
  if (!canPay.value || !selectedPlan.value) return
  const epoch = userEpoch
  paymentBusy.value = true
  paymentError.value = ''
  try {
    const providers = catalog.value?.payment.providers || []
    const provider = providers.length > 1 ? selectedProvider.value : providers[0]?.id
    const { key, storageKey } = keyFor(`${provider || 'default'}:${selectedPlan.value.id}`)
    const { order } = await vipApi.create(selectedPlan.value.id, key, provider || undefined)
    if (!active || epoch !== userEpoch) return
    requestKeys.delete(storageKey)
    try { sessionStorage.removeItem(storageKey) } catch { /* Storage is optional. */ }
    currentOrderId.value = order.id
    currentOrder.value = order
    orders.value = [order, ...orders.value.filter((item) => item.id !== order.id)]
    await nextTick()
    if (!active || epoch !== userEpoch) return
    document.getElementById('result-heading')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await refreshOrder()
    schedulePoll()
  } catch (error) {
    if (!active || epoch !== userEpoch) return
    paymentError.value = message(error)
    handleAuthError(error)
    if (account.user) await loadOrders()
  } finally { if (active && epoch === userEpoch) paymentBusy.value = false }
}

async function selectOrder(order: VipOrder) {
  stopPolling()
  currentOrderId.value = order.id
  currentOrder.value = order
  copiedField.value = ''
  copyError.value = ''
  orderBusy.value = false
  void refreshOrder()
  await nextTick()
  if (!active || currentOrderId.value !== order.id) return
  document.getElementById('result-heading')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function onVisibilityChange() {
  if (document.hidden) stopPolling()
  else if (currentOrder.value && isPending(currentOrder.value)) void refreshOrder()
}

watch(() => account.user?.id, (userId) => {
  userEpoch++
  stopPolling()
  orders.value = []
  currentOrder.value = null
  currentOrderId.value = returnOrderId
  orderError.value = ''
  ordersError.value = ''
  paymentError.value = ''
  paymentBusy.value = false
  ordersLoading.value = false
  orderBusy.value = false
  if (userId) {
    void loadOrders()
    if (currentOrderId.value) void refreshOrder()
  }
}, { immediate: true })

watchEffect(() => { document.title = tr('VIP 会员中心 · 短剧剧场', 'VIP Membership · Drama Theater') })

onMounted(() => {
  void loadCatalog()
  void refreshAccount()
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onUnmounted(() => { active = false; stopPolling(); document.removeEventListener('visibilitychange', onVisibilityChange) })
</script>

<template>
  <div class="vip-page">
    <SiteHeader />
    <main class="container vip-main">
      <nav class="vip-breadcrumb" :aria-label="tr('面包屑', 'Breadcrumb')"><router-link to="/">{{ tr('首页', 'Home') }}</router-link><span>/</span><span>{{ tr('VIP 会员中心', 'VIP Membership') }}</span></nav>
      <section class="vip-hero" aria-labelledby="vip-title">
        <div class="hero-copy">
          <p class="eyebrow"><span aria-hidden="true">✦</span> YOUR TIME, YOUR THEATER</p>
          <h1 id="vip-title">{{ tr('你的剧场，', 'Your theater, ') }}<br /><span>{{ tr('多一份热爱。', 'more to love.') }}</span></h1>
          <p class="hero-description">{{ tr('开通 VIP 会员，让精彩继续。', 'Join VIP and keep the stories going. ') }}<br />{{ tr('支持加密货币支付，按需充值，自由选择。', 'Pay with crypto and choose the time you want.') }}</p>
          <div class="hero-tags"><span>{{ tr('一次支付', 'One-time payment') }}</span><span>{{ tr('不自动续费', 'No auto-renewal') }}</span><span>{{ tr('会员时长可叠加', 'Extend your membership') }}</span></div>
        </div>
        <div class="membership-card" :class="{ 'is-member': account.user?.vipActive }">
          <div class="membership-top"><span>{{ tr('短剧剧场', 'Drama Theater') }}</span><span class="membership-logo">VIP <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 6 4.5 5L12 4l4.5 7L21 6l-2 13H5L3 6Z" /></svg></span></div>
          <div class="membership-title">{{ account.user?.vipActive ? tr('每一天，都值得期待', 'Something to enjoy, every day') : tr('故事之外，更多热爱', 'More stories to fall for') }}</div>
          <div class="membership-bottom">
            <div><small>{{ account.status === 'loading' ? tr('正在读取会员信息', 'Loading membership…') : account.user ? tr('当前会员状态', 'Membership status') : tr('登录后查看会员状态', 'Sign in to view membership') }}</small><strong>{{ account.user?.vipActive ? tr('VIP 会员', 'VIP member') : account.user ? tr('暂未开通 VIP', 'No active VIP membership') : tr('欢迎来到你的剧场', 'Welcome to your theater') }}</strong></div>
            <span class="card-emblem" aria-hidden="true">✦</span>
          </div>
          <p v-if="account.user?.vipExpiresAt" class="membership-expiry">{{ account.user.vipActive ? tr('有效期至', 'Valid until') : tr('已于以下时间到期', 'Expired on') }} {{ formatDate(account.user.vipExpiresAt) }}</p>
        </div>
      </section>

      <div v-if="account.status === 'error'" class="notice notice-error" role="alert">{{ tr('账号信息加载失败：', 'Unable to load your account: ') }}{{ translateMessage(account.error) }}<button type="button" @click="refreshAccount">{{ tr('重试', 'Retry') }}</button></div>

      <section v-if="returnedFromPayment || currentOrder" class="payment-result" aria-labelledby="result-heading" aria-live="polite">
        <div class="result-header"><div><p class="eyebrow">PAYMENT STATUS</p><h2 id="result-heading">{{ currentOrder ? statusLabels[currentOrder.status] || tr('等待确认', 'Awaiting confirmation') : tr('查看支付结果', 'View payment status') }}</h2></div><span v-if="currentOrder" class="status-dot" :class="currentOrder.status" aria-hidden="true" /></div>
        <template v-if="currentOrder">
          <p>{{ currentDescription }}</p><p class="order-reference">{{ translatePlanName(currentOrder.planName) }} · {{ price(currentOrder.payAmount ?? currentOrder.amount) }} {{ currentOrder.payCurrency || currentOrder.currency }} · {{ providerName(currentOrder.provider) }} · {{ tr('订单', 'Order') }} {{ currentOrder.id }}</p>
        </template>
        <p v-else>{{ account.user ? tr('正在核实订单状态，会员开通以实际到账结果为准。', 'Checking your order. Your membership starts once payment is confirmed.') : tr('请登录支付时使用的账号，查看订单与会员状态。', 'Sign in to the account used for payment to view your order and membership.') }}</p>
        <p v-if="orderError" class="inline-error" role="alert">{{ translateMessage(orderError) }}</p>
        <div v-if="currentOrder && vaehubActive(currentOrder) && currentOrder.checkoutUrl" class="transfer-panel">
          <div class="transfer-network"><span>{{ tr('支付通道', 'Payment channel') }}</span><strong>VaeHub · {{ currentOrder.payCurrency }}</strong></div>
          <div class="transfer-amount"><div><small>{{ tr('应付金额 · 在收银台完成支付', 'Amount due · Pay on the cashier page') }}</small><strong>{{ price(currentOrder.payAmount ?? currentOrder.amount) }} <span>{{ currentOrder.payCurrency }}</span></strong></div><a class="copy-button cashier-link" :href="currentOrder.checkoutUrl" target="_blank" rel="noopener">{{ tr('前往收银台支付', 'Open cashier') }}</a></div>
          <p v-if="currentOrder.qrString" class="address-expiry qr-string">{{ tr('二维码内容：', 'QR code content: ') }}{{ currentOrder.qrString }}</p>
          <p v-if="currentOrder.expiresAt" class="address-expiry">{{ tr(`请于 ${formatDate(currentOrder.expiresAt)} 前完成支付，过期后请勿继续支付。`, `Complete the payment before ${formatDate(currentOrder.expiresAt)}. Do not pay after expiry.`) }}</p>
          <p class="transfer-warning">{{ tr('支付完成后回到本页刷新状态，会员时长到账后自动更新。', 'Return here after payment and refresh the status. Your membership updates automatically once payment is confirmed.') }}</p>
        </div>
        <div v-if="currentOrder && canContinue(currentOrder) && !vaehubActive(currentOrder)" class="transfer-panel">
          <div class="transfer-network"><span>{{ tr('支付网络', 'Payment network') }}</span><strong>{{ currentOrder.network }}</strong></div>
          <div class="transfer-amount"><div><small>{{ tr('准确转入金额 · 手续费另付', 'Exact amount to send · Fees paid separately') }}</small><strong>{{ currentOrder.payAmount }} <span>USDT</span></strong></div><button class="copy-button" @click="copyPayment(String(currentOrder.payAmount), 'amount')">{{ copiedField === 'amount' ? tr('已复制金额', 'Amount copied') : tr('复制金额', 'Copy amount') }}</button></div>
          <label for="payment-address">{{ tr('专属 USDT 收款地址', 'Your USDT payment address') }}</label>
          <div class="address-field"><input id="payment-address" :value="currentOrder.payAddress" readonly @focus="($event.target as HTMLInputElement).select()" /><button class="copy-button" @click="copyPayment(currentOrder.payAddress!, 'address')">{{ copiedField === 'address' ? tr('已复制', 'Copied') : tr('复制地址', 'Copy address') }}</button></div>
          <p v-if="currentOrder.expiresAt" class="address-expiry">{{ tr(`请于 ${formatDate(currentOrder.expiresAt)} 前完成转账，过期后请勿继续支付。`, `Complete the transfer before ${formatDate(currentOrder.expiresAt)}. Do not pay after expiry.`) }}</p>
          <p v-else class="address-expiry">{{ tr('转账前请刷新订单，确认仍处于等待支付状态；过期后请勿继续转账。', 'Before sending funds, refresh the order to confirm it is still awaiting payment. Do not pay after it expires.') }}</p>
          <p class="transfer-warning">{{ tr('仅向此地址发送 TRON（TRC20）网络的 USDT。其他币种或网络可能导致资产无法找回。', 'Only send USDT on TRON (TRC20) to this address. Using another currency or network may result in permanent loss of funds.') }}</p>
          <p v-if="copyError" class="inline-error" role="alert">{{ translateMessage(copyError) }}</p>
          <p v-else-if="copiedField" class="copy-success" role="status">{{ copiedField === 'address' ? tr('收款地址已复制', 'Payment address copied') : tr('支付金额已复制', 'Payment amount copied') }}</p>
        </div>
        <div v-if="account.user" class="result-actions">
          <button v-if="currentOrderId" class="button-secondary compact" :disabled="orderBusy" @click="refreshOrder">{{ orderBusy ? tr('正在查询…', 'Checking…') : tr('刷新支付状态', 'Refresh payment status') }}</button>
          
          <span v-if="currentOrder && isPending(currentOrder) && !orderError" class="auto-refresh-note">{{ tr('页面停留时自动更新', 'Updates automatically while this page is open') }}</span>
        </div>
      </section>

      <section class="plans-section" aria-labelledby="plans-heading">
        <div class="section-title"><div><p class="eyebrow">CHOOSE YOUR PLAN</p><h2 id="plans-heading">{{ tr('选择你的会员时光', 'Choose your VIP plan') }}</h2></div><span>{{ tr('USDT 支付 · 充值即购买会员天数', 'Pay in USDT · Purchase membership days') }}</span></div>
        <div v-if="catalogLoading" class="loading-block" role="status">{{ tr('正在加载会员套餐…', 'Loading VIP plans…') }}</div>
        <div v-else-if="catalogError" class="notice notice-error" role="alert">{{ translateMessage(catalogError) }}<button type="button" @click="loadCatalog">{{ tr('重新加载', 'Reload') }}</button></div>
        <template v-else-if="catalog">
          <fieldset class="plans-grid" :disabled="paymentBusy"><legend class="visually-hidden">{{ tr('选择 VIP 会员套餐', 'Choose a VIP plan') }}</legend>
            <label v-for="plan in catalog.plans" :key="plan.id" class="plan-card" :class="{ selected: selectedId === plan.id, recommended: plan.recommended }">
              <input v-model="selectedId" type="radio" name="vip-plan" :value="plan.id" />
              <span v-if="plan.recommended" class="plan-badge">{{ tr('推荐之选', 'Recommended') }}</span>
              <div class="plan-top"><span class="plan-mark" aria-hidden="true">✦</span><span class="radio-mark" aria-hidden="true" /></div>
              <h3>{{ translatePlanName(plan.name) }}</h3><p class="plan-duration">{{ tr(`${plan.days} 天会员时光`, `${plan.days} days of VIP`) }}</p>
              <p class="plan-price"><strong>{{ price(plan.price) }}</strong><small>USDT</small></p>
              <div class="plan-divider" /><p class="plan-detail"><span aria-hidden="true">✓</span> {{ tr(`${plan.days} 天 VIP 会员有效期`, `${plan.days} days of VIP access`) }}</p><p class="plan-detail"><span aria-hidden="true">✓</span> {{ tr('一次充值，到期不扣费', 'Pay once, no auto-renewal') }}</p>
            </label>
          </fieldset>
          <p v-if="!catalog.plans.length" class="notice">{{ tr('会员套餐准备中，请稍后再来。', 'VIP plans are being prepared. Please check back soon.') }}</p>
          <div v-if="!catalog.payment.enabled" class="notice availability" role="status"><span class="notice-symbol" aria-hidden="true">i</span><div><strong>{{ tr('加密货币支付暂未开放', 'Crypto payments are not available yet') }}</strong><p>{{ tr('你可以先注册账号。支付服务开放后，即可在这里开通会员。', 'Create your account now. You can join VIP here once payments become available.') }}</p></div></div>

          <div class="checkout-grid">
            <section class="payment-method" aria-labelledby="method-heading">
              <div class="method-heading"><span class="crypto-icon" aria-hidden="true">₮</span><div><h3 id="method-heading">{{ tr('选择支付方式', 'Choose a payment method') }}</h3><p>{{ providerNames || tr('USDT / 法币支付', 'Pay in USDT / fiat') }}</p></div><span class="method-check" aria-hidden="true">✓</span></div>
              <div v-if="(catalog.payment.providers || []).length > 1" class="provider-list" role="radiogroup" :aria-label="tr('选择支付通道', 'Choose a payment channel')">
                <label v-for="item in catalog.payment.providers" :key="item.id" class="provider-card" :class="{ selected: selectedProvider === item.id }">
                  <input v-model="selectedProvider" type="radio" name="vip-provider" :value="item.id" />
                  <span class="radio-mark" aria-hidden="true" />
                  <span class="provider-name">{{ providerName(item.id) }}</span>
                  <small>{{ item.id === 'vaehub' ? tr('法币 · 收银台 / 二维码', 'Fiat · Cashier / QR code') : tr('USDT 转账地址', 'USDT transfer address') }}</small>
                </label>
              </div>
              <div class="currency-list" :aria-label="tr('支持的支付币种', 'Supported payment currencies')">{{ currencyText }}</div>
              <ol class="payment-steps"><li><span>01</span><div><strong>{{ tr('选择套餐并登录', 'Choose a plan and sign in') }}</strong><p>{{ tr('订单和会员时长将绑定当前账号。', 'Your order and membership will be linked to this account.') }}</p></div></li><li><span>02</span><div><strong>{{ tr('按订单完成支付', 'Complete the payment') }}</strong><p>{{ tr('跳转收银台付款，或按地址转入指定金额。', 'Pay on the cashier page, or send the exact amount to the payment address.') }}</p></div></li><li><span>03</span><div><strong>{{ tr('等待到账，自动开通', 'Wait for automatic activation') }}</strong><p>{{ tr('确认后更新会员有效期，可在本页查看进度。', 'Your membership updates after confirmation. Track its progress on this page.') }}</p></div></li></ol>
              <p class="network-note">{{ tr('不同通道的到账币种与网络以订单显示为准。转账网络手续费由你另行承担，请确保实际到账金额与订单一致。', 'The settlement currency and network depend on the channel shown on your order. Network fees are paid separately. Make sure the amount received matches your order.') }}</p>
            </section>
            <section class="checkout-panel" aria-labelledby="checkout-heading">
              <template v-if="account.status === 'loading'"><h3 id="checkout-heading">{{ tr('确认你的账号', 'Confirm your account') }}</h3><p class="loading-account" role="status">{{ tr('正在加载账号信息…', 'Loading your account…') }}</p></template>
              <template v-else-if="!account.user"><h3 id="checkout-heading">{{ tr('登录后开通会员', 'Sign in to join VIP') }}</h3><p class="checkout-subtitle">{{ tr('让会员时光，保存在你的账号里。', 'Keep your membership with your account.') }}</p><AccountPanel /></template>
              <template v-else>
                <h3 id="checkout-heading">{{ tr('确认充值', 'Confirm your purchase') }}</h3><p class="checkout-account">{{ account.user.email }}</p>
                <div class="summary-row"><span>{{ tr('会员套餐', 'Plan') }}</span><strong>{{ selectedPlan ? translatePlanName(selectedPlan.name) : tr('请选择套餐', 'Choose a plan') }}</strong></div><div class="summary-row"><span>{{ tr('会员时长', 'Duration') }}</span><strong>{{ tr(`${selectedPlan?.days || '—'} 天`, `${selectedPlan?.days || '—'} days`) }}</strong></div><div class="summary-row"><span>{{ tr('支付方式', 'Payment method') }}</span><strong>{{ tr('加密货币', 'Crypto') }}</strong></div>
                <div v-if="(catalog.payment.providers || []).length > 1" class="summary-row"><span>{{ tr('支付通道', 'Payment channel') }}</span><strong>{{ providerName(selectedProvider) }}</strong></div>
                <div class="checkout-total"><span>{{ tr('支付金额', 'Total') }}</span><strong v-if="selectedPlan">{{ price(selectedPlan.price) }} <small>USDT</small></strong><strong v-else>—</strong></div>
                <button class="pay-button" :disabled="!canPay" @click="createOrder">{{ paymentBusy ? tr('正在创建订单…', 'Creating order…') : !catalog.payment.enabled ? tr('支付暂未开放', 'Payments unavailable') : account.user.vipActive ? tr('续费 VIP · 去支付', 'Renew VIP · Pay now') : tr('开通 VIP · 去支付', 'Join VIP · Pay now') }}<span v-if="!paymentBusy" aria-hidden="true">↗</span></button>
                <p class="checkout-note">{{ tr('支付完成后回到本页刷新，会员时长到账后自动生效，不会自动续费。', 'Return here after payment and refresh. Membership starts once payment is confirmed. No automatic renewal.') }}</p>
              </template>
              <p v-if="paymentError" class="inline-error" role="alert">{{ translateMessage(paymentError) }}</p>
            </section>
          </div>
        </template>
      </section>

      <section class="membership-info" :aria-label="tr('充值说明', 'Membership information')"><div><span aria-hidden="true">↗</span><h3>{{ tr('时长自动叠加', 'Your membership time adds up') }}</h3><p>{{ tr('会员有效期内续费，将在原到期时间后增加所购天数；到期后充值，从到账确认时开始计算。', 'Renew an active membership to add days to your current expiry date. If your membership has expired, the new term starts when payment is confirmed.') }}</p></div><div><span aria-hidden="true">◷</span><h3>{{ tr('第 1 集免费，第 2 集起解锁', 'Episode 1 free, episode 2 onward unlocked') }}</h3><p>{{ tr('每部剧第 1 集可免费观看，开通会员后解锁全部剧集。所有套餐均为一次性购买，到期不会自动扣款。', 'Episode 1 of every series is free. VIP unlocks every episode. All plans are one-time purchases with no automatic charges at expiry.') }}</p></div></section>

      <section v-if="account.user" class="orders-section" aria-labelledby="orders-heading">
        <div class="section-title"><div><p class="eyebrow">YOUR ORDERS</p><h2 id="orders-heading">{{ tr('充值记录', 'Payment history') }}</h2></div><button class="text-action" :disabled="ordersLoading" @click="loadOrders">{{ ordersLoading ? tr('加载中…', 'Loading…') : tr('刷新记录', 'Refresh orders') }} <span aria-hidden="true">↻</span></button></div>
        <p v-if="ordersError" class="notice notice-error" role="alert">{{ translateMessage(ordersError) }}</p>
        <p v-else-if="ordersLoading && !orders.length" class="loading-block" role="status">{{ tr('正在读取充值记录…', 'Loading your payment history…') }}</p>
        <div v-else-if="orders.length" class="order-list">
          <article v-for="order in orders" :key="order.id" class="order-row"><div class="order-icon" aria-hidden="true">✦</div><div class="order-details"><h3>{{ translatePlanName(order.planName) }} <span>{{ tr(`${order.days} 天`, `${order.days} days`) }}</span></h3><p>{{ formatDate(order.createdAt) }} · {{ providerName(order.provider) }}</p><small>{{ order.id }}</small></div><div class="order-amount">{{ price(order.payAmount ?? order.amount) }} <small>{{ order.payCurrency || order.currency }}</small><span class="order-status" :class="order.status">{{ statusLabels[order.status] || tr('等待确认', 'Awaiting confirmation') }}</span></div><div class="order-actions"><button class="text-action" @click="selectOrder(order)">{{ tr('查看状态', 'View status') }}</button><button v-if="canContinue(order)" class="continue-payment" @click="selectOrder(order)">{{ vaehubActive(order) ? tr('前往收银台', 'Open cashier') : tr('查看支付地址', 'Payment address') }}</button></div></article>
        </div>
        <div v-else class="empty-orders"><span aria-hidden="true">✦</span><h3>{{ tr('还没有充值记录', 'No payments yet') }}</h3><p>{{ tr('你的每一笔会员充值，都会记录在这里。', 'All your VIP purchases will appear here.') }}</p></div>
      </section>
    </main>
    <SiteFooter />
  </div>
</template>

<style scoped>
.vip-page { --vip-gold: #e9c47e; --vip-muted: #a29987; min-height: 100vh; }
.vip-main { max-width: 1100px; }
.vip-breadcrumb { display: flex; gap: 10px; padding-top: 92px; font-size: 12px; color: var(--fg-3); }
.vip-breadcrumb span:last-child { color: #c4c6ce; }
.vip-hero { display: grid; grid-template-columns: 1fr .88fr; align-items: center; gap: 70px; padding: 52px 0 64px; }
.eyebrow { color: var(--vip-gold); font-size: 10px; font-weight: 700; letter-spacing: 2.3px; }
.eyebrow > span { margin-right: 8px; }
.hero-copy h1 { font-size: clamp(35px,4.6vw,54px); font-weight: 800; letter-spacing: -2px; line-height: 1.28; margin: 19px 0; }
.hero-copy h1 > span { color: var(--vip-gold); }
.hero-description { font-size: 14px; line-height: 1.9; color: var(--fg-2); }
.hero-tags { display: flex; flex-wrap: wrap; gap: 0; color: #c9c5bb; font-size: 11px; margin-top: 24px; }
.hero-tags span + span::before { content: '·'; padding: 0 12px; color: var(--vip-gold); }
.membership-card { position: relative; isolation: isolate; overflow: hidden; min-height: 254px; padding: 28px; border: 1px solid rgba(233,196,126,.4); border-radius: 19px; background: linear-gradient(120deg,#30302f,#202327 48%,#393327); box-shadow: 0 30px 70px -35px #b2894745, inset 0 1px 0 #ffffff15; transform: rotate(-3deg); }
.membership-card::before { content: ''; position: absolute; z-index: -1; width: 390px; height: 390px; border: 1px solid #e9c47e15; border-radius: 50%; right: -220px; top: -128px; box-shadow: 0 0 0 28px #e9c47e06,0 0 0 57px #e9c47e05,0 0 0 87px #e9c47e04; }
.membership-top,.membership-bottom { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.membership-top { font-size: 12px; letter-spacing: 2px; color: #d3c5aa; }
.membership-logo { display: flex; gap: 8px; align-items: center; color: var(--vip-gold); font-size: 20px; font-weight: 800; font-style: italic; letter-spacing: 0; }
.membership-logo svg { height: 21px; width: 21px; fill: none; stroke: currentColor; stroke-width: 1.4; }
.membership-title { color: #f5e2bb; margin: 30px 0; font-size: 23px; font-weight: 600; letter-spacing: 1px; }
.membership-bottom small { display: block; color: #b5ac9a; font-size: 10px; }
.membership-bottom strong { display: block; color: #eee5d5; font-size: 12px; letter-spacing: 1px; margin-top: 4px; }
.card-emblem { font-size: 35px; color: #d9ba7e; }
.membership-expiry { margin-top: 10px; color: #ded0b7; font-size: 11px; }
.section-title { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.section-title h2 { margin-top: 7px; font-size: 24px; letter-spacing: -.6px; }
.section-title > span { font-size: 12px; color: var(--fg-3); }
.plans-grid { margin: 0; padding: 0; border: 0; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 18px; }
.plan-card { position: relative; cursor: pointer; background: #13151d; border: 1px solid #ffffff15; border-radius: 16px; padding: 25px; transition: border-color .2s,background .2s; }
.plan-card:hover { border-color: #e9c47e80; }
.plan-card.selected { border-color: var(--vip-gold); background: linear-gradient(155deg,#2b261d,#181a20 75%); box-shadow: inset 0 0 0 1px #e9c47e12; }
.plan-card input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.plan-card:has(input:focus-visible) { outline: 2px solid var(--vip-gold); outline-offset: 4px; }
.visually-hidden { position: absolute; height: 1px; width: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.plan-badge { position: absolute; top: -11px; right: 20px; border: 1px solid #e9c47e; border-radius: 6px; background: #e9c47e; padding: 2px 11px; color: #312517; font-size: 10px; font-weight: 700; }
.plan-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
.plan-mark { color: var(--vip-gold); font-size: 23px; line-height: 1; }
.radio-mark { width: 17px; height: 17px; border: 1px solid #ffffff35; border-radius: 50%; }
.selected .radio-mark { border: 5px solid var(--vip-gold); background: #392d18; }
.plan-card h3 { font-size: 20px; font-weight: 700; }
.plan-duration { font-size: 12px; color: var(--fg-3); margin-top: 4px; }
.plan-price { margin: 20px 0 19px; display: flex; align-items: baseline; gap: 4px; }
.plan-price > span { font-size: 19px; font-weight: 500; color: #ded3bc; }
.plan-price strong { font-size: 39px; line-height: 1.2; font-weight: 700; letter-spacing: -1.5px; }
.selected .plan-price strong { color: #f6dcab; }
.plan-price small { font-size: 11px; color: var(--fg-3); margin-left: 5px; }
.plan-divider { border-top: 1px solid #ffffff0d; margin-bottom: 17px; }
.plan-detail { font-size: 12px; color: #b1b5c2; margin-top: 9px; }
.plan-detail span { color: var(--vip-gold); margin-right: 7px; }
.notice { display: flex; align-items: center; gap: 12px; padding: 16px 20px; font-size: 13px; border-radius: 12px; border: 1px solid #ffffff12; background: #ffffff04; color: #bfc1ca; margin-top: 20px; }
.notice button { margin-left: auto; color: #fff; text-decoration: underline; white-space: nowrap; }
.notice-error { color: var(--accent-fg-soft); background: var(--accent-soft); border-color: var(--accent-line); }
.availability { background: #e9c47e08; border-color: #e9c47e20; }
.availability strong { color: #dbc494; font-size: 12px; }
.availability p { margin-top: 2px; color: #9d998f; font-size: 12px; }
.notice-symbol { width: 21px; height: 21px; flex-shrink: 0; border: 1px solid #c2a575; border-radius: 50%; text-align: center; font-size: 13px; line-height: 19px; color: var(--vip-gold); }
.checkout-grid { display: grid; grid-template-columns: 1.12fr 1fr; gap: 28px; margin-top: 28px; }
.payment-method,.checkout-panel { padding: 28px; border: 1px solid #ffffff12; border-radius: 16px; background: #11141c; }
.method-heading { display: flex; align-items: center; gap: 13px; }
.crypto-icon { flex-shrink: 0; display: grid; place-items: center; width: 43px; height: 43px; background: #e9c47e12; border-radius: 12px; color: var(--vip-gold); font-size: 28px; font-weight: 500; }
.method-heading h3,.checkout-panel h3 { font-size: 17px; }
.method-heading p { font-size: 11px; margin-top: 3px; color: var(--fg-3); }
.method-check { margin-left: auto; color: var(--vip-gold); }
.currency-list { display: inline-block; padding: 6px 10px; margin-top: 22px; background: #ffffff05; border: 1px solid #ffffff0b; border-radius: 7px; color: #b3bbc9; font-size: 11px; letter-spacing: .8px; overflow-wrap: anywhere; }
.payment-steps { list-style: none; margin: 25px 0; padding: 0; display: grid; gap: 22px; }
.payment-steps li { display: flex; align-items: start; gap: 13px; }
.payment-steps li > span { color: #9c875e; border-bottom: 1px solid #9c875e50; font-size: 11px; line-height: 21px; }
.payment-steps strong { color: #d2d5df; font-size: 13px; font-weight: 500; }
.payment-steps p { margin-top: 3px; color: var(--fg-3); font-size: 11px; line-height: 1.8; }
.provider-list { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 18px; }
.provider-card { position: relative; cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 12px 13px; border: 1px solid #ffffff15; border-radius: 10px; background: #ffffff04; font-size: 12px; }
.provider-card:hover { border-color: #e9c47e60; }
.provider-card.selected { border-color: var(--vip-gold); background: #e9c47e0d; }
.provider-card input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.provider-card .radio-mark { width: 14px; height: 14px; border: 1px solid #ffffff35; border-radius: 50%; flex-shrink: 0; }
.provider-card.selected .radio-mark { border: 4px solid var(--vip-gold); background: #392d18; }
.provider-card .provider-name { color: #d9dce4; font-weight: 700; white-space: nowrap; }
.provider-card small { color: var(--fg-3); font-size: 10px; margin-left: auto; text-align: right; }
.cashier-link { text-decoration: none; display: inline-flex; align-items: center; }
.qr-string { overflow-wrap: anywhere; word-break: break-all; }
.network-note { padding-top: 17px; border-top: 1px solid #ffffff0a; color: #878c9a; font-size: 11px; line-height: 1.9; }
.checkout-subtitle { color: var(--fg-3); font-size: 12px; margin: 6px 0 19px; }
.checkout-account { color: var(--fg-3); font-size: 12px; margin: 4px 0 25px; overflow-wrap: anywhere; }
.summary-row { display: flex; justify-content: space-between; gap: 14px; margin-top: 14px; font-size: 13px; }
.summary-row span { color: var(--fg-3); }
.summary-row strong { text-align: right; color: #ced2dd; font-weight: 500; }
.checkout-total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 24px; padding-top: 18px; border-top: 1px solid #ffffff0d; gap: 12px; }
.checkout-total > span { font-size: 13px; color: #bac0d0; }
.checkout-total strong { color: #f1d6a1; font-size: 29px; letter-spacing: -.8px; }
.checkout-total small { color: #a7987c; font-size: 11px; font-weight: 400; }
.pay-button { display: flex; width: 100%; align-items: center; justify-content: center; gap: 15px; background: linear-gradient(110deg,#f3d9a5,#d6af6b); color: #332516; border-radius: 10px; padding: 14px 15px; margin-top: 18px; font-size: 14px; font-weight: 700; }
.pay-button:hover:not(:disabled) { box-shadow: 0 6px 26px #e9c47e25; }
.pay-button:disabled { opacity: .5; }
.checkout-note { font-size: 11px; line-height: 1.9; color: var(--fg-3); margin-top: 13px; text-align: center; }
.inline-error { color: var(--accent-fg-soft) !important; font-size: 12px; margin-top: 14px; }
.loading-account { padding: 50px 0; color: var(--fg-3); font-size: 13px; text-align: center; }
.membership-info { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; padding: 28px 4px; margin-bottom: 23px; }
.membership-info > div { display: grid; grid-template-columns: 28px 1fr; column-gap: 8px; }
.membership-info span { color: var(--vip-gold); font-size: 20px; line-height: 1; }
.membership-info h3 { color: #cacbd2; font-size: 13px; font-weight: 500; }
.membership-info p { grid-column: 2; color: var(--fg-3); font-size: 11px; margin-top: 7px; line-height: 1.9; }
.orders-section { padding-top: 28px; border-top: 1px solid #ffffff0d; margin-bottom: 50px; }
.empty-orders { text-align: center; padding: 40px 20px; border: 1px dashed #ffffff15; border-radius: 14px; }
.empty-orders > span { color: #887149; font-size: 28px; }
.empty-orders h3 { font-size: 14px; color: #c2c7d2; margin-top: 9px; font-weight: 500; }
.empty-orders p { font-size: 12px; color: var(--fg-3); margin-top: 4px; }
.order-list { border: 1px solid #ffffff12; border-radius: 14px; overflow: hidden; }
.order-row { display: flex; align-items: center; gap: 16px; padding: 20px; background: #11141c; }
.order-row + .order-row { border-top: 1px solid #ffffff0c; }
.order-icon { width: 42px; height: 42px; display: grid; place-items: center; flex-shrink: 0; background: #e9c47e0a; color: var(--vip-gold); border-radius: 11px; font-size: 21px; }
.order-details { flex: 1; min-width: 0; }
.order-details h3 { font-size: 14px; }
.order-details h3 span { margin-left: 7px; color: var(--fg-3); font-size: 11px; font-weight: 400; }
.order-details p { color: var(--fg-3); font-size: 11px; margin-top: 4px; }
.order-details > small { display: block; color: #676e80; font-size: 10px; overflow-wrap: anywhere; }
.order-amount { color: #eee2c9; font-size: 15px; text-align: right; flex-shrink: 0; }
.order-amount small { font-size: 10px; color: var(--fg-3); }
.order-status { display: block; font-size: 11px; margin-top: 6px; color: #d4b578; }
.order-status.paid { color: #8ccbaf; }
.order-status.failed,.order-status.expired,.order-status.refunded { color: #999cab; }
.order-actions { display: flex; flex-direction: column; gap: 8px; margin-left: 12px; min-width: 82px; }
.text-action { color: #d1bd94; font-size: 12px; white-space: nowrap; }
.text-action:hover { color: #f4d99e; }
.text-action > span { margin-left: 5px; }
.continue-payment { padding: 7px 11px; border: 1px solid #e9c47e35; border-radius: 8px; font-size: 11px; color: var(--vip-gold); }
.loading-block { color: var(--fg-3); text-align: center; padding: 50px 24px; font-size: 14px; border: 1px solid #ffffff10; border-radius: 14px; }
.payment-result { border: 1px solid #e9c47e35; border-radius: 16px; padding: 25px; margin-bottom: 36px; background: #24201665; }
.result-header { display: flex; align-items: center; justify-content: space-between; }
.result-header h2 { font-size: 20px; color: #f0d6a6; margin: 5px 0 10px; }
.payment-result > p { color: #b4b3b1; font-size: 13px; line-height: 1.8; }
.payment-result > p.order-reference { font-size: 11px; color: #85888f; margin-top: 9px; overflow-wrap: anywhere; }
.status-dot { width: 12px; height: 12px; border-radius: 50%; background: #d5b578; box-shadow: 0 0 0 6px #d5b57810; }
.status-dot.paid { background: #8ccbaf; box-shadow: 0 0 0 6px #8ccbaf10; }
.result-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; margin-top: 17px; }
.transfer-panel { padding: 20px; margin-top: 20px; background: #0d1018; border: 1px solid #e9c47e25; border-radius: 12px; }
.transfer-network { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; }
.transfer-network > span { color: #9498a5; }
.transfer-network strong { color: #e2c994; border: 1px solid #e9c47e25; border-radius: 5px; background: #e9c47e08; padding: 3px 8px; font-size: 11px; font-weight: 500; }
.transfer-amount { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin: 18px 0; }
.transfer-amount small { display: block; font-size: 11px; color: var(--fg-3); }
.transfer-amount strong { display: block; font-size: 32px; color: #f1d8aa; letter-spacing: -1px; margin-top: 2px; }
.transfer-amount strong > span { font-size: 12px; font-weight: 500; letter-spacing: 0; }
.copy-button { color: #e8cc94; border: 1px solid #e9c47e30; background: #e9c47e08; padding: 8px 11px; border-radius: 7px; font-size: 11px; white-space: nowrap; }
.copy-button:hover { background: #e9c47e15; }
.transfer-panel > label { display: block; font-size: 12px; margin-bottom: 8px; color: #afb4c2; }
.address-field { display: flex; gap: 8px; }
.address-field input { min-width: 0; flex: 1; color: #dedbd2; border: 1px solid #ffffff17; background: #ffffff03; border-radius: 8px; padding: 10px 11px; font-family: monospace; font-size: 13px; }
.address-expiry { color: #8c93a4; font-size: 11px; line-height: 1.8; margin-top: 9px; }
.transfer-warning { color: #d0b984; font-size: 11px; line-height: 1.8; margin-top: 14px; }
.copy-success { color: #8ccbaf; font-size: 11px; margin-top: 10px; }
.compact { padding: 8px 13px; border-radius: 8px; font-size: 12px; }
.auto-refresh-note { font-size: 11px; color: #88857e; }
@media (max-width: 900px) {
  .vip-hero { gap: 30px; padding-top: 38px; }
  .membership-card { padding: 23px; }
  .membership-title { font-size: 19px; }
  .plan-card { padding: 21px; }
  .checkout-grid { gap: 18px; grid-template-columns: 1fr 1fr; }
  .payment-method,.checkout-panel { padding: 23px; }
}
@media (max-width: 650px) {
  .vip-breadcrumb { padding-top: 18px; }
  .vip-hero { grid-template-columns: 1fr; padding: 31px 0 43px; gap: 30px; }
  .hero-copy h1 { font-size: 38px; letter-spacing: -1.5px; margin: 15px 0; }
  .hero-copy h1 br { display: none; }
  .hero-description { font-size: 13px; }
  .hero-description br { display: none; }
  .hero-tags { margin-top: 15px; font-size: 10px; }
  .membership-card { transform: rotate(0); min-height: 220px; padding: 24px; }
  .membership-title { font-size: 22px; margin: 24px 0; }
  .section-title { flex-wrap: wrap; align-items: center; row-gap: 7px; margin-bottom: 21px; }
  .section-title h2 { font-size: 21px; }
  .section-title > span { font-size: 10px; }
  .eyebrow { font-size: 9px; letter-spacing: 1.6px; }
  .plans-grid { gap: 9px; }
  .plan-card { padding: 20px 11px 16px; border-radius: 12px; }
  .plan-top { margin-bottom: 13px; }
  .plan-mark { font-size: 19px; }
  .radio-mark { width: 14px; height: 14px; }
  .selected .radio-mark { border-width: 4px; }
  .plan-badge { right: 7px; padding: 2px 7px; font-size: 9px; }
  .plan-card h3 { font-size: 16px; }
  .plan-duration { font-size: 10px; }
  .plan-price { gap: 1px; flex-wrap: wrap; margin: 15px 0; }
  .plan-price > span { font-size: 12px; }
  .plan-price strong { font-size: clamp(21px,6.2vw,34px); letter-spacing: -1px; }
  .plan-price small { font-size: 9px; margin-left: 1px; }
  .plan-divider { margin-bottom: 12px; }
  .plan-detail { font-size: 10px; line-height: 1.8; margin-top: 4px; }
  .plan-detail span { margin-right: 2px; }
  .checkout-grid { grid-template-columns: 1fr; gap: 17px; margin-top: 20px; }
  .payment-method,.checkout-panel { padding: 22px; }
  .payment-steps { gap: 16px; }
  .membership-info { grid-template-columns: 1fr; gap: 20px; padding: 24px 4px; margin-bottom: 5px; }
  .notice { padding: 14px; gap: 10px; }
  .availability p { font-size: 11px; }
  .order-row { padding: 16px; flex-wrap: wrap; gap: 12px; }
  .order-icon { display: none; }
  .order-details { flex-basis: 50%; }
  .order-amount { font-size: 14px; }
  .order-actions { flex-direction: row; justify-content: flex-end; width: 100%; align-items: center; gap: 18px; margin: 0; }
  .payment-result { padding: 20px; margin-bottom: 27px; }
  .transfer-panel { padding: 15px; }
  .transfer-amount { flex-wrap: wrap; gap: 10px; }
  .transfer-amount strong { overflow-wrap: anywhere; }
  .order-actions { flex-wrap: wrap; }
  .result-actions { gap: 12px; }
  .auto-refresh-note { width: 100%; }
}
@media (max-width: 370px) { .hero-copy h1 { font-size: 33px; }.plan-card { padding-inline: 8px; }.plan-price small { display: none; }.plan-detail { font-size: 9px; } }
@media (max-width: 480px) {
  :lang(en) .plans-grid { grid-template-columns: 1fr; gap: 18px; }
  :lang(en) .plan-card { padding: 20px; }
  :lang(en) .plan-top { position: absolute; top: 23px; right: 20px; margin: 0; }
  :lang(en) .plan-mark { display: none; }
  :lang(en) .plan-card h3 { padding-right: 25px; font-size: 18px; }
  :lang(en) .plan-duration, :lang(en) .plan-detail { font-size: 12px; }
  :lang(en) .plan-price { gap: 5px; margin: 12px 0; }
  :lang(en) .plan-price strong { font-size: 30px; }
  :lang(en) .plan-price small { display: inline; font-size: 11px; }
}
</style>
