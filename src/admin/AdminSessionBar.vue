<script setup lang="ts">
/** 后台顶栏的登录状态条：显示当前管理员与退出按钮。 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { adminLogout, adminSession, type AdminArea } from './api'

const props = defineProps<{ area: AdminArea }>()
const admin = computed(() => adminSession[props.area].admin)

async function logout() {
  try {
    await adminLogout(props.area)
    ElMessage.success('已退出登录')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '退出失败，请重试。')
  }
}
</script>

<template>
  <div v-if="admin" class="admin-session">
    <el-tag size="small" type="info">{{ admin.displayName }}（{{ admin.username }}）</el-tag>
    <el-button size="small" @click="logout">退出登录</el-button>
  </div>
</template>

<style scoped>
.admin-session {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
