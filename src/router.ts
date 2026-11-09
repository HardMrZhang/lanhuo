import { createRouter, createWebHistory } from 'vue-router'

/**
 * 全站路由。
 *
 * 用户端页面与后台共用同一个 SPA 入口：
 *   /            用户端（首页、剧集、播放、会员、邀请）
 *   /admin/*     后台（支付、推荐）
 *
 * 后台全部走懒加载，Element Plus 只在后台被访问时才会下载，
 * 用户端首屏不会为后台付出任何体积代价。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./views/Home.vue') },
    { path: '/vip', name: 'vip', component: () => import('./views/Vip.vue') },
    { path: '/invite', name: 'invite', component: () => import('./views/Invite.vue') },
    { path: '/verify-email', name: 'verify-email', component: () => import('./views/VerifyEmail.vue') },
    { path: '/reset-password', name: 'reset-password', component: () => import('./views/ResetPassword.vue') },
    {
      path: '/drama/:id',
      name: 'detail',
      component: () => import('./views/Detail.vue'),
      props: (route) => ({ id: String(route.params.id) }),
    },
    {
      path: '/play/:id/:ep?',
      name: 'play',
      component: () => import('./views/Player.vue'),
      props: (route) => ({
        id: String(route.params.id),
        ep: route.params.ep ? Number(route.params.ep) : 1,
      }),
    },
    // ---------- 后台 ----------
    {
      path: '/admin',
      component: () => import('./admin/AdminLayout.vue'),
      children: [
        { path: '', redirect: '/admin/payment' },
        {
          path: 'payment',
          name: 'admin-payment',
          component: () => import('./admin/PaymentAdmin.vue'),
          meta: { title: '支付管理后台', area: 'payment' },
        },
        {
          path: 'recommend',
          name: 'admin-recommend',
          component: () => import('./admin/RecommendAdmin.vue'),
          meta: { title: '推荐系统后台', area: 'recommend' },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})
