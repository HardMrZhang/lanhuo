<script setup lang="ts">
/**
 * 后台登录表单。
 *
 * 两个后台共用这个组件，但各自绑定自己的登录态与接口前缀 ——
 * 支付角色进不了推荐后台，反之亦然。
 */
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminLogin, type AdminArea } from './api'

const props = defineProps<{ area: AdminArea }>()
const emit = defineEmits<{ done: [] }>()

const username = ref('')
const password = ref('')
const loading = ref(false)

async function submit() {
  if (loading.value) return
  loading.value = true
  try {
    await adminLogin(props.area, username.value.trim(), password.value)
    password.value = ''
    emit('done')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '登录失败，请重试。')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-card class="admin-login-card" shadow="never">
    <template #header>
      <strong>管理员登录</strong>
    </template>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="用户名">
        <el-input v-model="username" autocomplete="username" placeholder="请输入管理员用户名" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input
          v-model="password"
          type="password"
          autocomplete="current-password"
          show-password
          placeholder="请输入密码"
          @keyup.enter="submit"
        />
      </el-form-item>
      <el-button type="primary" :loading="loading" style="width: 100%" @click="submit">登录</el-button>
    </el-form>
  </el-card>
</template>

<style scoped>
.admin-login-card {
  max-width: 380px;
  margin: 8vh auto 0;
}
</style>
