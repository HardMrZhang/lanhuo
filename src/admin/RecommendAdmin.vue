<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiFor, adminRestore, adminSession, type AdminArea } from './api'
import AdminLogin from './AdminLogin.vue'

const area: AdminArea = 'recommend'
const api = apiFor(area)

interface Slot {
  id: string
  key: string
  name: string
  description: string
  enabled: boolean
  weight: number
  itemLimit: number
  itemCount: number
  updatedAt: number
}

interface Item {
  id: string
  slotId: string
  dramaId: string
  title: string
  cover: string
  weight: number
  enabled: boolean
  sortOrder: number
  updatedAt: number
}

interface DramaOption {
  id: string
  title: string
}

const slots = ref<Slot[]>([])
const overview = ref<{ key: string; name: string; enabled: boolean; weight: number; itemLimit: number; totalItems: number; enabledItems: number }[]>([])
const currentSlot = ref<Slot | null>(null)
const items = ref<Item[]>([])
const dramas = ref<DramaOption[]>([])

const newSlot = reactive({ key: '', name: '', description: '', weight: 0, itemLimit: 10 })
const addDramaId = ref('')

const enabledItems = computed(() => items.value.filter((item) => item.enabled).length)

function formatDate(timestamp: number) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function loadSlots() {
  const result = await api.get<{ slots: Slot[] }>('/slots')
  slots.value = result.slots
  if (currentSlot.value) {
    const found = result.slots.find((slot) => slot.id === currentSlot.value?.id)
    currentSlot.value = found ?? result.slots[0] ?? null
  } else {
    currentSlot.value = result.slots[0] ?? null
  }
}

async function loadOverview() {
  const result = await api.get<{ overview: typeof overview.value }>('/overview')
  overview.value = result.overview
}

async function loadItems() {
  if (!currentSlot.value) {
    items.value = []
    return
  }
  const result = await api.get<{ items: Item[] }>(`/slots/${currentSlot.value.id}/items`)
  items.value = result.items
}

/** 可推荐的剧列表：优先用公开剧集接口，失败时允许手动输入 dramaId。 */
async function loadDramas() {
  try {
    const response = await fetch('/api/dramas')
    if (!response.ok) return
    const list = await response.json() as { id: string; title: string }[]
    dramas.value = list.map((item) => ({ id: item.id, title: item.title }))
  } catch {
    // 剧集列表拿不到时不阻塞后台其它功能。
  }
}

async function loadAll() {
  await Promise.all([loadSlots(), loadOverview(), loadItems()])
}

/** 登录成功后拉取数据。 */
async function onLoggedIn() {
  await loadAll()
  await loadDramas()
}

async function createSlot() {
  if (!newSlot.key.trim() || !newSlot.name.trim()) {
    ElMessage.warning('请填写推荐位标识与名称')
    return
  }
  try {
    const result = await api.post<{ slot: Slot }>('/slots', {
      key: newSlot.key.trim(),
      name: newSlot.name.trim(),
      description: newSlot.description.trim(),
      weight: Number(newSlot.weight) || 0,
      itemLimit: Number(newSlot.itemLimit) || 10,
    })
    ElMessage.success(`推荐位 ${result.slot.name} 已创建`)
    newSlot.key = ''
    newSlot.name = ''
    newSlot.description = ''
    newSlot.weight = 0
    newSlot.itemLimit = 10
    currentSlot.value = result.slot
    await loadAll()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建失败，请重试。')
  }
}

async function updateSlot(patch: Partial<Slot>) {
  if (!currentSlot.value) return
  try {
    await api.patch(`/slots/${currentSlot.value.id}`, patch)
    ElMessage.success('已保存')
    await loadAll()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败，请重试。')
  }
}

async function deleteSlot() {
  if (!currentSlot.value) return
  try {
    await ElMessageBox.confirm(`删除推荐位「${currentSlot.value.name}」？其下条目会一并删除。`, '删除推荐位', {
      type: 'error', confirmButtonText: '删除', cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await api.delete(`/slots/${currentSlot.value.id}`)
    ElMessage.success('已删除')
    currentSlot.value = null
    await loadAll()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败，请重试。')
  }
}

async function addItem() {
  if (!currentSlot.value) return
  const dramaId = addDramaId.value.trim()
  if (!dramaId) return
  try {
    await api.post(`/slots/${currentSlot.value.id}/items`, { dramaId })
    ElMessage.success('已加入推荐位')
    addDramaId.value = ''
    await loadAll()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '添加失败，请重试。')
  }
}

async function updateItem(id: string, patch: Partial<Item>) {
  try {
    await api.patch(`/items/${id}`, patch)
    await loadItems()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败，请重试。')
  }
}

async function deleteItem(id: string) {
  try {
    await ElMessageBox.confirm('从该推荐位移除这条内容？', '移除', { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' })
  } catch {
    return
  }
  try {
    await api.delete(`/items/${id}`)
    ElMessage.success('已移除')
    await loadAll()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败，请重试。')
  }
}

onMounted(async () => {
  const admin = await adminRestore(area)
  if (admin) {
    await loadAll()
    await loadDramas()
  }
})
</script>

<template>
  <div>
    <!-- 未登录：只显示登录表单 -->
    <AdminLogin v-if="!adminSession[area].admin" :area="area" @done="onLoggedIn" />

    <!-- 已登录：显示业务数据 -->
    <template v-else>
      <el-card shadow="never" class="section-card">
        <template #header><strong>推荐位概览</strong></template>
        <el-table :data="overview" size="small" empty-text="还没有推荐位">
          <el-table-column prop="key" label="标识" width="180" />
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column label="启用" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '是' : '否' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="weight" label="权重" width="80" />
          <el-table-column prop="itemLimit" label="展示上限" width="100" />
          <el-table-column label="启用 / 已配置" width="120">
            <template #default="{ row }">{{ row.enabledItems }} / {{ row.totalItems }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="section-card">
        <template #header><strong>新建推荐位</strong></template>
        <el-form :inline="true" @submit.prevent="createSlot">
          <el-form-item label="标识">
            <el-input v-model="newSlot.key" placeholder="home_featured" style="width: 180px" />
          </el-form-item>
          <el-form-item label="名称">
            <el-input v-model="newSlot.name" placeholder="首页轮播" style="width: 180px" />
          </el-form-item>
          <el-form-item label="说明">
            <el-input v-model="newSlot.description" style="width: 200px" />
          </el-form-item>
          <el-form-item label="权重">
            <el-input-number v-model="newSlot.weight" :controls="false" style="width: 90px" />
          </el-form-item>
          <el-form-item label="展示条数">
            <el-input-number v-model="newSlot.itemLimit" :min="1" :max="100" :controls="false" style="width: 90px" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="createSlot">创建</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="section-card">
        <template #header><strong>推荐位列表</strong></template>
        <el-table :data="slots" size="small" empty-text="还没有推荐位">
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column prop="key" label="标识" width="180" />
          <el-table-column prop="itemCount" label="条目数" width="90" />
          <el-table-column prop="weight" label="权重" width="80" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="currentSlot = row; loadItems()">管理条目</el-button>
              <el-button size="small" :type="row.enabled ? 'warning' : 'success'" plain @click="updateSlot({ enabled: !row.enabled })">
                {{ row.enabled ? '停用' : '启用' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card v-if="currentSlot" shadow="never" class="section-card">
        <template #header>
          <strong>条目管理 · {{ currentSlot.name }}</strong>
        </template>
        <el-form :inline="true">
          <el-form-item label="名称">
            <el-input :model-value="currentSlot.name" style="width: 160px" @change="updateSlot({ name: ($event as string) })" />
          </el-form-item>
          <el-form-item label="权重">
            <el-input-number
              :model-value="currentSlot.weight"
              :controls="false"
              style="width: 90px"
              @change="(value: number | undefined) => updateSlot({ weight: Number(value) || 0 })"
            />
          </el-form-item>
          <el-form-item label="展示条数">
            <el-input-number
              :model-value="currentSlot.itemLimit"
              :min="1"
              :max="100"
              :controls="false"
              style="width: 90px"
              @change="(value: number | undefined) => updateSlot({ itemLimit: Number(value) || 10 })"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="danger" plain @click="deleteSlot">删除推荐位</el-button>
          </el-form-item>
        </el-form>

        <el-form :inline="true" style="margin-top: 8px">
          <el-form-item label="添加剧">
            <el-select v-model="addDramaId" filterable placeholder="选择要推荐的剧" style="width: 280px">
              <el-option v-for="drama in dramas" :key="drama.id" :label="drama.title" :value="drama.id" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :disabled="!addDramaId" @click="addItem">添加</el-button>
          </el-form-item>
        </el-form>

        <el-table :data="items" size="small" empty-text="该推荐位还没有条目">
          <el-table-column prop="title" label="剧名" min-width="180" show-overflow-tooltip />
          <el-table-column prop="dramaId" label="ID" width="180" show-overflow-tooltip />
          <el-table-column label="权重" width="110">
            <template #default="{ row }">
              <el-input-number
                :model-value="row.weight"
                :controls="false"
                size="small"
                style="width: 90px"
                @change="(value: number | undefined) => updateItem(row.id, { weight: Number(value) || 0 })"
              />
            </template>
          </el-table-column>
          <el-table-column label="顺序" width="110">
            <template #default="{ row }">
              <el-input-number
                :model-value="row.sortOrder"
                :controls="false"
                size="small"
                style="width: 90px"
                @change="(value: number | undefined) => updateItem(row.id, { sortOrder: Number(value) || 0 })"
              />
            </template>
          </el-table-column>
          <el-table-column label="启用" width="80">
            <template #default="{ row }">
              <el-switch
                :model-value="row.enabled"
                @change="(value: string | number | boolean) => updateItem(row.id, { enabled: Boolean(value) })"
              />
            </template>
          </el-table-column>
          <el-table-column label="更新时间" width="170">
            <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="danger" plain @click="deleteItem(row.id)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <p class="hint">
          启用条目 {{ enabledItems }} / {{ items.length }} 条。权重越大越靠前；同权重按顺序值排序（顺序值大的在前）。
        </p>
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.section-card {
  margin-bottom: 16px;
}
.hint {
  margin-top: 12px;
  color: #909399;
  font-size: 12px;
}
</style>
