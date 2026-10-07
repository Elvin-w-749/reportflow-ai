import { createApp } from 'vue'
import 'vant/lib/index.css'
import './styles/global.css'
import './styles/responsive.css'
import App from './App.vue'
import router from './router/index.js'
import { installUni, setRouter } from './compat/uni.js'
import { setupVant } from './compat/vantAdapter.js'
import ScrollView from './compat/components/ScrollView.vue'

const app = createApp(App)

// Vant 组件注册（须在 installUni 之前，确保 overlay 委托时可调用 Vant API）
setupVant(app)

installUni()
setRouter(router)

app.component('scroll-view', ScrollView)
app.use(router)
app.mount('#app')
