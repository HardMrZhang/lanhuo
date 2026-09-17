<script setup lang="ts">
</script>

<template>
  <router-view v-slot="{ Component, route }">
    <keep-alive include="Home">
      <component :is="Component" :key="route.name === 'home' ? 'home' : route.fullPath" />
    </keep-alive>
  </router-view>
</template>
