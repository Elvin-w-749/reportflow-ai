import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', redirect: '/pages/home/home' },
  { path: '/official', component: () => import('@/pages/official/Official.vue') },
  { path: '/pages/home/home', component: () => import('@/pages/home/Home.vue'), meta: { tab: true } },
  { path: '/pages/match/index', component: () => import('@/pages/match/Match.vue'), meta: { tab: true } },
  { path: '/pages/message/center', component: () => import('@/pages/message/Center.vue'), meta: { tab: true } },
  { path: '/pages/profile/profile', component: () => import('@/pages/profile/Profile.vue'), meta: { tab: true } },
  { path: '/pages/report/upload', component: () => import('@/pages/report/Upload.vue') },
  { path: '/pages/report/manage', component: () => import('@/pages/report/Manage.vue') },
  { path: '/pages/report/detail', component: () => import('@/pages/report/Detail.vue') },
  { path: '/pages/login/index', component: () => import('@/pages/login/Login.vue') },
  { path: '/pages/login/register', component: () => import('@/pages/login/Register.vue') },
  { path: '/pages/login/change-password', component: () => import('@/pages/login/ChangePassword.vue') },
  { path: '/pages/login/reset-password', component: () => import('@/pages/login/ResetPassword.vue') },
  { path: '/pages/legal/document', component: () => import('@/pages/legal/Document.vue') },
  { path: '/pages/profile/debt-manage', component: () => import('@/pages/profile/DebtManage.vue') },
  { path: '/pages/profile/supplement-materials', component: () => import('@/pages/profile/SupplementMaterials.vue') },
  { path: '/pages/profile/repayment-reminder', component: () => import('@/pages/profile/RepaymentReminder.vue') },
  { path: '/pages/profile/advisor', component: () => import('@/pages/profile/Advisor.vue') },
	  { path: '/pages/chat/conversation', component: () => import('@/pages/chat/Conversation.vue') },
	  { path: '/pages/admin/workbench', component: () => import('@/pages/admin/Workbench.vue') },
	  { path: '/pages/admin/monitor', component: () => import('@/pages/admin/Monitor.vue') },
	  { path: '/pages/service/workbench', component: () => import('@/pages/service/Workbench.vue') },
  { path: '/pages/bank/workbench', component: () => import('@/pages/teacher/Workbench.vue') },
  { path: '/pages/teacher/apply', component: () => import('@/pages/teacher/Apply.vue') },
  { path: '/pages/teacher/reviewing', component: () => import('@/pages/teacher/Reviewing.vue') },
  { path: '/pages/teacher/workbench', component: () => import('@/pages/teacher/Workbench.vue') },
  { path: '/pages/teacher/clients', component: () => import('@/pages/teacher/Clients.vue') },
  { path: '/pages/teacher/tasks', component: () => import('@/pages/teacher/Tasks.vue') },
  { path: '/pages/teacher/client-detail', component: () => import('@/pages/teacher/ClientDetail.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/pages/home/home' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  }
})

export default router
