import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./views/Home.vue') },
    { path: '/vip', name: 'vip', component: () => import('./views/Vip.vue') },
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
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})
