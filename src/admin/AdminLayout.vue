<script setup lang="ts">
/**
 * 后台布局。
 *
 * Element Plus 的组件样式由 unplugin-vue-components 的 resolver 按需注入
 * （见 vite.config.ts），这里不需要再全量 import 它的 CSS，
 * 否则整包样式会被打进这个 chunk。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const area = computed(() => (route.meta.area === 'recommend' ? 'recommend' : 'payment'))

const title = computed(() => (area.value === 'recommend' ? '推荐系统后台' : '支付管理后台'))
</script>

<template>
  <el-container class="admin-layout">
    <el-aside width="220px" class="admin-aside">
      <div class="admin-brand">
        <strong>短剧剧场</strong>
        <small>管理后台</small>
      </div>
      <el-menu :default-active="`/admin/${area}`" router class="admin-menu">
        <el-menu-item index="/admin/payment">
          <span>支付管理</span>
        </el-menu-item>
        <el-menu-item index="/admin/recommend">
          <span>推荐管理</span>
        </el-menu-item>
      </el-menu>
      <div class="admin-aside-foot">
        <router-link to="/" class="admin-back">← 返回前台</router-link>
      </div>
    </el-aside>
    <el-main class="admin-main">
      <header class="admin-head">
        <h1>{{ title }}</h1>
        <admin-session-bar :area="area" />
      </header>
      <router-view v-slot="{ Component }">
        <keep-alive :include="['PaymentAdmin', 'RecommendAdmin']">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </el-main>
  </el-container>
</template>

<style scoped>
.admin-layout {
  min-height: 100dvh;
  background: #f5f7fa;
}
.admin-aside {
  display: flex;
  flex-direction: column;
  background: #1f2430;
  --el-menu-bg-color: #1f2430;
  --el-menu-text-color: rgba(255, 255, 255, 0.72);
  --el-menu-hover-bg-color: #2a3040;
  --el-menu-active-color: #ffffff;
}
.admin-brand {
  padding: 20px 18px 16px;
  color: #fff;
}
.admin-brand strong {
  display: block;
  font-size: 16px;
}
.admin-brand small {
  display: block;
  margin-top: 2px;
  color: rgba(255, 255, 255, 0.45);
  font-size: 12px;
}
.admin-menu {
  flex: 1;
  border-right: 0;
}
.admin-aside-foot {
  padding: 14px 18px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.admin-back {
  color: rgba(255, 255, 255, 0.6);
  font-size: 13px;
}
.admin-back:hover {
  color: #fff;
}
.admin-main {
  padding: 20px 24px 40px;
}
.admin-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.admin-head h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
</style>
