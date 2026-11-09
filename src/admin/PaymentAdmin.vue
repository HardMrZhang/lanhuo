<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiFor, adminRestore, adminSession, type AdminArea } from './api'
import AdminLogin from './AdminLogin.vue'

const area: AdminArea = 'payment'
const api = apiFor(area)

interface AdminOrder {
  id: string
  userId: string
  email: string | null
  planId: string
  planName: string
  days: number
  amount: number
  currency: string
  status: string
  statusLabel: string
  provider: string
  providerLabel: string
  payAmount: number | null
  payCurrency: string | null
  payAddress: string | null
  txHash: string | null
  reviewReason: string | null
  invoiceId: string | null
  paymentId: string | null
  createdAt: number
  paidAt: number | null
  expiresAt: string | null
}

interface AdminUserRow {
  id: string
  email: string
  vipActive: boolean
  vipExpiresAt: number | null
  emailVerified: boolean
  createdAt: number
  orderCount: number
  paidAmount: number
}

interface Stats {
  totals: { orders: number; paid: number; revenue: number; review: number; pending: number; members: number }
  byStatus: { status: string; label: string; count: number }[]
  byProvider: { provider: string; label: string; count: number; revenue: number }[]
  daily: { day: string; orders: number; revenue: number }[]
}

interface ReferralStats {
  total: number
  today: number
  codeUsers: number
  topInviters: { userId: string; email: string; count: number }[]
  relations: { id: string; code: string; source: string; boundAt: number; inviter: string; invitee: string }[]
}

const activeTab = ref('overview')
const stats = ref<Stats | null>(null)
const orders = ref<AdminOrder[]>([])
const ordersTotal = ref(0)
const reviewOrders = ref<AdminOrder[]>([])
const users = ref<AdminUserRow[]>([])
const usersTotal = ref(0)
const referral = ref<ReferralStats | null>(null)

const orderQuery = reactive({ page: 1, pageSize: 20, status: '', provider: '', q: '' })
const userQuery = reactive({ page: 1, pageSize: 20, q: '' })

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'creating', label: '创建中' },
  { value: 'pending', label: '等待支付' },
  { value: 'confirming', label: '支付确认中' },
  { value: 'partially_paid', label: '待补足金额' },
  { value: 'paid', label: '支付成功' },
  { value: 'failed', label: '支付失败' },
  { value: 'expired', label: '已过期作废' },
  { value: 'refunded', label: '已退款' },
  { value: 'review', label: '等待人工核实' },
]
const PROVIDER_OPTIONS = [
  { value: '', label: '全部通道' },
  { value: 'nowpayments', label: 'NOWPayments (USDT)' },
  { value: 'vaehub', label: 'VaeHub (法币)' },
  { value: 'bsc', label: 'BSC 链自建地址' },
]

const STATUS_TAG: Record<string, string> = {
  paid: 'success',
  review: 'warning',
  failed: 'danger',
  expired: 'danger',
  refunded: 'info',
  pending: 'primary',
  confirming: 'primary',
  creating: 'info',
  partially_paid: 'warning',
}

const maxDaily = computed(() => Math.max(1, ...(stats.value?.daily ?? []).map((item) => item.orders)))

function formatDate(timestamp: number | null | undefined) {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function loadStats() {
  stats.value = await api.get<Stats>('/stats')
}

async function loadOrders() {
  const params = new URLSearchParams({ page: String(orderQuery.page), pageSize: String(orderQuery.pageSize) })
  if (orderQuery.status) params.set('status', orderQuery.status)
  if (orderQuery.provider) params.set('provider', orderQuery.provider)
  if (orderQuery.q.trim()) params.set('q', orderQuery.q.trim())
  const result = await api.get<{ orders: AdminOrder[]; total: number }>(`/orders?${params}`)
  orders.value = result.orders
  ordersTotal.value = result.total
}

async function loadReview() {
  const result = await api.get<{ orders: AdminOrder[] }>('/review')
  reviewOrders.value = result.orders
}

async function loadUsers() {
  const params = new URLSearchParams({ page: String(userQuery.page), pageSize: String(userQuery.pageSize) })
  if (userQuery.q.trim()) params.set('q', userQuery.q.trim())
  const result = await api.get<{ users: AdminUserRow[]; total: number }>(`/users?${params}`)
  users.value = result.users
  usersTotal.value = result.total
}

async function loadReferral() {
  referral.value = await api.get<ReferralStats>('/referral')
}

async function loadAll() {
  await Promise.all([loadStats(), loadOrders(), loadReview(), loadUsers(), loadReferral()])
}

function searchOrders() {
  orderQuery.page = 1
  void loadOrders()
}

function searchUsers() {
  userQuery.page = 1
  void loadUsers()
}

/** 人工核实：确认到账 —— 走订单状态机开通会员，与支付回调同一套账本。 */
async function reviewConfirm(order: AdminOrder) {
  try {
    await ElMessageBox.confirm(
      `确认订单 ${order.id} 已收到款项？确认后会按订单天数开通会员。`,
      '确认到账',
      { type: 'warning', confirmButtonText: '确认到账', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await api.post(`/orders/${order.id}/review`, { action: 'confirm' })
    ElMessage.success('已确认到账并开通会员')
    await loadAll()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败，请重试。')
  }
}

/** 人工核实：确认未到账。 */
async function reviewReject(order: AdminOrder) {
  try {
    await ElMessageBox.confirm(
      `确认订单 ${order.id} 未收到款项？该订单将被标记为支付失败。`,
      '确认未到账',
      { type: 'error', confirmButtonText: '确认未到账', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await api.post(`/orders/${order.id}/review`, { action: 'reject' })
    ElMessage.success('已标记为支付失败')
    await loadAll()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败，请重试。')
  }
}

/** 后台手动补单：给用户加会员天数。 */
async function grant(user: AdminUserRow) {
  let days = 30
  try {
    const result = await ElMessageBox.prompt(`给 ${user.email} 增加多少天会员？`, '手动开通会员', {
      inputValue: '30',
      inputPattern: /^\d+$/,
      inputErrorMessage: '请输入 1–3650 的整数',
      confirmButtonText: '开通',
      cancelButtonText: '取消',
    })
    days = Number(result.value)
  } catch {
    return
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    ElMessage.error('天数必须是 1–3650 的整数')
    return
  }
  try {
    await api.post(`/users/${user.id}/grant`, { days })
    ElMessage.success(`已为 ${user.email} 增加 ${days} 天会员`)
    await loadAll()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败，请重试。')
  }
}

onMounted(async () => {
  const admin = await adminRestore(area)
  if (admin) await loadAll()
})
</script>

<template>
  <div>
    <!-- 未登录：只显示登录表单 -->
    <AdminLogin v-if="!adminSession[area].admin" :area="area" @done="loadAll" />

    <!-- 已登录：显示业务数据 -->
    <template v-else>
      <el-tabs v-model="activeTab" class="admin-tabs">
        <!-- 数据概览 -->
        <el-tab-pane label="数据概览" name="overview">
          <el-row :gutter="16">
            <el-col v-for="tile in stats ? [
              { label: '累计订单', value: stats.totals.orders },
              { label: '支付成功', value: stats.totals.paid },
              { label: '收入（USDT）', value: stats.totals.revenue.toFixed(2) },
              { label: '待支付', value: stats.totals.pending },
              { label: '等待人工核实', value: stats.totals.review },
              { label: '有效会员', value: stats.totals.members },
            ] : []" :key="tile.label" :xs="12" :sm="8" :md="4">
              <el-card shadow="never" class="stat-card">
                <div class="stat-value">{{ tile.value }}</div>
                <div class="stat-label">{{ tile.label }}</div>
              </el-card>
            </el-col>
          </el-row>

          <el-card shadow="never" class="section-card">
            <template #header><strong>近 30 天订单量</strong></template>
            <div class="bar-chart">
              <div
                v-for="item in stats?.daily ?? []"
                :key="item.day"
                class="bar"
                :style="{ height: `${(item.orders / maxDaily) * 100}%` }"
                :title="`${item.day}：${item.orders} 单 / ${item.revenue.toFixed(2)} USDT`"
              />
            </div>
          </el-card>

          <el-row :gutter="16">
            <el-col :xs="24" :md="12">
              <el-card shadow="never" class="section-card">
                <template #header><strong>按支付通道</strong></template>
                <el-table :data="stats?.byProvider ?? []" size="small" empty-text="暂无数据">
                  <el-table-column prop="label" label="通道" />
                  <el-table-column prop="count" label="订单数" width="100" />
                  <el-table-column label="收入（USDT）" width="140">
                    <template #default="{ row }">{{ row.revenue.toFixed(2) }}</template>
                  </el-table-column>
                </el-table>
              </el-card>
            </el-col>
            <el-col :xs="24" :md="12">
              <el-card shadow="never" class="section-card">
                <template #header><strong>按订单状态</strong></template>
                <el-table :data="stats?.byStatus ?? []" size="small" empty-text="暂无数据">
                  <el-table-column label="状态" width="160">
                    <template #default="{ row }">
                      <el-tag size="small" :type="(STATUS_TAG[row.status] as never) || 'info'">{{ row.label }}</el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column prop="count" label="订单数" />
                </el-table>
              </el-card>
            </el-col>
          </el-row>
        </el-tab-pane>

        <!-- 订单管理 -->
        <el-tab-pane label="订单管理" name="orders">
          <el-card shadow="never" class="section-card">
            <div class="filter-bar">
              <el-select v-model="orderQuery.status" placeholder="状态" clearable style="width: 160px">
                <el-option v-for="option in STATUS_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-select v-model="orderQuery.provider" placeholder="支付通道" clearable style="width: 180px">
                <el-option v-for="option in PROVIDER_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-input
                v-model="orderQuery.q"
                placeholder="订单号 / 邮箱 / 交易号"
                clearable
                style="width: 260px"
                @keyup.enter="searchOrders"
                @clear="searchOrders"
              />
              <el-button type="primary" @click="searchOrders">筛选</el-button>
              <el-button @click="loadOrders">刷新</el-button>
            </div>
            <el-table :data="orders" size="small" stripe empty-text="没有符合条件的订单" style="width: 100%">
              <el-table-column label="订单号" width="130">
                <template #default="{ row }"><span class="mono">{{ row.id.slice(0, 8) }}</span></template>
              </el-table-column>
              <el-table-column prop="email" label="用户" min-width="180" show-overflow-tooltip />
              <el-table-column label="套餐" min-width="160">
                <template #default="{ row }">{{ row.planName }} · {{ row.days }} 天</template>
              </el-table-column>
              <el-table-column label="金额" width="120">
                <template #default="{ row }">{{ row.amount.toFixed(2) }} {{ row.currency }}</template>
              </el-table-column>
              <el-table-column prop="providerLabel" label="通道" width="150" />
              <el-table-column label="状态" width="130">
                <template #default="{ row }">
                  <el-tag size="small" :type="(STATUS_TAG[row.status] as never) || 'info'">{{ row.statusLabel }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="创建时间" width="160">
                <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="支付时间" width="160">
                <template #default="{ row }">{{ formatDate(row.paidAt) }}</template>
              </el-table-column>
            </el-table>
            <el-pagination
              v-model:current-page="orderQuery.page"
              :page-size="orderQuery.pageSize"
              :total="ordersTotal"
              layout="total, prev, pager, next"
              class="pager"
              @current-change="loadOrders"
            />
          </el-card>
        </el-tab-pane>

        <!-- 人工核实 -->
        <el-tab-pane name="review">
          <template #label>
            <span>人工核实<el-badge v-if="reviewOrders.length" :value="reviewOrders.length" class="tab-badge" /></span>
          </template>
          <el-alert
            type="warning"
            :closable="false"
            title="这里只处理结果不明的订单：确认到账会开通会员，确认未到账则标记失败。"
            style="margin-bottom: 16px"
          />
          <el-card shadow="never" class="section-card">
            <el-table :data="reviewOrders" size="small" stripe empty-text="当前没有等待人工核实的订单" style="width: 100%">
              <el-table-column prop="id" label="订单号" min-width="200" show-overflow-tooltip />
              <el-table-column prop="email" label="用户" min-width="180" show-overflow-tooltip />
              <el-table-column label="应付" width="140">
                <template #default="{ row }">{{ row.payAmount ?? row.amount }} {{ row.payCurrency || row.currency }}</template>
              </el-table-column>
              <el-table-column prop="providerLabel" label="通道" width="150" />
              <el-table-column prop="reviewReason" label="原因" min-width="180" show-overflow-tooltip />
              <el-table-column label="创建时间" width="160">
                <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="200" fixed="right">
                <template #default="{ row }">
                  <el-button size="small" type="success" @click="reviewConfirm(row)">确认到账</el-button>
                  <el-button size="small" type="danger" plain @click="reviewReject(row)">确认未到账</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-tab-pane>

        <!-- 会员用户 -->
        <el-tab-pane label="会员用户" name="users">
          <el-card shadow="never" class="section-card">
            <div class="filter-bar">
              <el-input
                v-model="userQuery.q"
                placeholder="搜索邮箱"
                clearable
                style="width: 260px"
                @keyup.enter="searchUsers"
                @clear="searchUsers"
              />
              <el-button type="primary" @click="searchUsers">搜索</el-button>
              <el-button @click="loadUsers">刷新</el-button>
            </div>
            <el-table :data="users" size="small" stripe style="width: 100%">
              <el-table-column prop="email" label="邮箱" min-width="200" show-overflow-tooltip />
              <el-table-column label="会员状态" width="110">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.vipActive ? 'success' : 'info'">{{ row.vipActive ? '有效' : '未开通' }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="到期时间" width="170">
                <template #default="{ row }">{{ formatDate(row.vipExpiresAt) }}</template>
              </el-table-column>
              <el-table-column label="邮箱验证" width="100">
                <template #default="{ row }">{{ row.emailVerified ? '已验证' : '未验证' }}</template>
              </el-table-column>
              <el-table-column prop="orderCount" label="订单数" width="90" />
              <el-table-column label="累计支付" width="130">
                <template #default="{ row }">{{ row.paidAmount.toFixed(2) }} USDT</template>
              </el-table-column>
              <el-table-column label="操作" width="120" fixed="right">
                <template #default="{ row }">
                  <el-button size="small" @click="grant(row)">手动开通</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-pagination
              v-model:current-page="userQuery.page"
              :page-size="userQuery.pageSize"
              :total="usersTotal"
              layout="total, prev, pager, next"
              class="pager"
              @current-change="loadUsers"
            />
          </el-card>
        </el-tab-pane>

        <!-- 邀请数据 -->
        <el-tab-pane label="邀请数据" name="referral">
          <el-alert
            type="info"
            :closable="false"
            title="邀请关系只做来源统计，不发放奖励。"
            style="margin-bottom: 16px"
          />
          <el-row :gutter="16">
            <el-col v-for="tile in referral ? [
              { label: '邀请关系总数', value: referral.total },
              { label: '今日新增', value: referral.today },
              { label: '已生成邀请码', value: referral.codeUsers },
            ] : []" :key="tile.label" :xs="12" :sm="8">
              <el-card shadow="never" class="stat-card">
                <div class="stat-value">{{ tile.value }}</div>
                <div class="stat-label">{{ tile.label }}</div>
              </el-card>
            </el-col>
          </el-row>
          <el-card shadow="never" class="section-card">
            <template #header><strong>邀请最多的用户</strong></template>
            <el-table :data="referral?.topInviters ?? []" size="small" empty-text="暂无邀请数据">
              <el-table-column prop="email" label="用户" />
              <el-table-column prop="count" label="邀请人数" width="120" />
            </el-table>
          </el-card>
          <el-card shadow="never" class="section-card">
            <template #header><strong>邀请记录</strong></template>
            <el-table :data="referral?.relations ?? []" size="small" empty-text="暂无邀请记录" style="width: 100%">
              <el-table-column prop="code" label="邀请码" width="120" />
              <el-table-column prop="inviter" label="邀请人" min-width="160" />
              <el-table-column prop="invitee" label="被邀请人" min-width="160" />
              <el-table-column prop="source" label="来源" width="100" />
              <el-table-column label="时间" width="170">
                <template #default="{ row }">{{ formatDate(row.boundAt) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-tab-pane>
      </el-tabs>
    </template>
  </div>
</template>

<style scoped>
.admin-tabs {
  background: #fff;
  border-radius: 8px;
  padding: 0 16px 16px;
}
.stat-card {
  margin-bottom: 16px;
}
.stat-value {
  font-size: 24px;
  font-weight: 600;
}
.stat-label {
  margin-top: 4px;
  color: #909399;
  font-size: 13px;
}
.section-card {
  margin-bottom: 16px;
}
.filter-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.bar-chart {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 140px;
  padding-top: 12px;
}
.bar {
  flex: 1;
  min-width: 2px;
  border-radius: 2px 2px 0 0;
  background: #409eff;
  opacity: 0.75;
}
.bar:hover {
  opacity: 1;
}
.tab-badge {
  margin-left: 6px;
  vertical-align: top;
}
</style>
