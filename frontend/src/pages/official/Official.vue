<template>
  <main class="official-site">
    <nav class="official-nav" aria-label="产品官网导航">
      <a class="brand" href="#official-top" aria-label="回到官网首页">
        <span class="brand-mark">报</span>
        <span class="brand-text">
          <strong>分析报告工作台</strong>
          <small>信用材料协同系统</small>
        </span>
      </a>
      <div class="nav-links">
        <a href="#official-capabilities">能力</a>
        <a href="#official-flow">流程</a>
        <a href="#official-security">安全</a>
        <a href="#official-contact">联系</a>
      </div>
      <a class="nav-action" href="#/pages/home/home">进入系统</a>
    </nav>

    <section id="official-top" class="official-hero">
      <div class="hero-atmosphere" aria-hidden="true">
        <span class="mesh mesh-a"></span>
        <span class="mesh mesh-b"></span>
        <span class="mesh mesh-c"></span>
        <span class="data-line data-line-a"></span>
        <span class="data-line data-line-b"></span>
      </div>

      <div class="hero-visual" aria-hidden="true">
        <div class="hero-visual-text">
          <span>报告识别</span>
          <span>材料补充</span>
          <span>咨询群聊</span>
          <span>产品匹配</span>
        </div>
      </div>

      <div class="hero-copy" data-reveal>
        <p class="eyebrow">产品官网 · Web 服务入口</p>
        <h1>分析报告工作台</h1>
        <p class="hero-lead">
          面向信用报告解读、补充材料管理、产品路径规划和浏览器咨询协同的数字化服务系统。
        </p>
        <div class="hero-actions">
          <a class="primary-action" href="#/pages/home/home">进入业务系统</a>
          <a class="secondary-action" href="#official-flow">查看服务流程</a>
        </div>
        <div class="hero-badges" aria-label="产品核心特点">
          <span>报告结构化</span>
          <span>材料分级留档</span>
          <span>客服协同接单</span>
        </div>
      </div>

      <div class="hero-metrics" data-reveal>
        <div v-for="metric in metrics" :key="metric.label" class="metric-tile">
          <strong>{{ metric.display }}</strong>
          <span>{{ metric.label }}</span>
        </div>
      </div>
    </section>

    <section id="official-capabilities" class="section-band light-band">
      <div class="section-inner">
        <div class="section-heading" data-reveal>
          <p class="eyebrow">核心能力</p>
          <h2>把复杂的信用材料，拆成可判断、可沟通、可留档的流程。</h2>
          <p>
            本系统不承诺审批结果，也不替代金融机构风控。系统重点是帮助用户看清材料、补齐信息、规划沟通路径。
          </p>
        </div>
        <div class="capability-grid">
          <article v-for="item in capabilities" :key="item.title" class="capability-card" data-reveal>
            <span class="capability-icon" :class="item.tone">{{ item.short }}</span>
            <h3>{{ item.title }}</h3>
            <p>{{ item.desc }}</p>
          </article>
        </div>
      </div>
    </section>

    <section id="official-flow" class="section-band flow-band">
      <div class="section-inner flow-layout">
        <div class="section-heading compact" data-reveal>
          <p class="eyebrow">服务路径</p>
          <h2>从上传报告到人工协同，步骤清晰。</h2>
          <p>
            用户先完成报告与补充材料上传，系统生成风险提示和材料摘要，再由客服和认证银行老师按权限进入沟通。
          </p>
        </div>

        <div class="flow-rail" data-reveal>
          <article v-for="(step, index) in flowSteps" :key="step.title" class="flow-step">
            <span class="step-index">{{ index + 1 }}</span>
            <div>
              <h3>{{ step.title }}</h3>
              <p>{{ step.desc }}</p>
            </div>
          </article>
        </div>

        <aside class="live-panel" data-reveal aria-label="系统动态示意">
          <div class="live-header">
            <span class="pulse-dot"></span>
            <strong>流程动态</strong>
          </div>
          <ul>
            <li v-for="item in liveEvents" :key="item">{{ item }}</li>
          </ul>
        </aside>
      </div>
    </section>

    <section class="section-band role-band">
      <div class="section-inner">
        <div class="section-heading" data-reveal>
          <p class="eyebrow">角色协作</p>
          <h2>客户、客服、银行老师和管理员各看各的，权限边界清楚。</h2>
        </div>
        <div class="role-grid">
          <article v-for="role in roles" :key="role.title" class="role-card" data-reveal>
            <span>{{ role.tag }}</span>
            <h3>{{ role.title }}</h3>
            <p>{{ role.desc }}</p>
          </article>
        </div>
      </div>
    </section>

    <section id="official-security" class="section-band security-band">
      <div class="section-inner security-layout">
        <div class="section-heading compact" data-reveal>
          <p class="eyebrow">合规与安全</p>
          <h2>围绕资料授权、隐私边界和操作留痕建设。</h2>
          <p>
            客户资料只在授权范围内使用。普通用户、加盟账号、客服、银行老师和管理员在同一 Web 系统中采用不同权限视图。
          </p>
        </div>
        <div class="security-list" data-reveal>
          <div v-for="item in security" :key="item.title" class="security-item">
            <strong>{{ item.title }}</strong>
            <span>{{ item.desc }}</span>
          </div>
        </div>
      </div>
    </section>

    <section id="official-contact" class="official-cta">
      <div class="cta-copy" data-reveal>
        <p class="eyebrow">浏览器 Web 服务</p>
        <h2>官网可作为服务展示、协议说明和技术支持入口。</h2>
        <p>
          当前官网入口用于说明系统能力，并承载联系方式、用户协议和 Web 技术支持。
        </p>
      </div>
      <div class="cta-actions" data-reveal>
        <a class="primary-action" href="#/pages/home/home">打开分析报告工作台</a>
        <a class="secondary-action light" href="#/pages/legal/document">查看协议入口</a>
      </div>
    </section>
  </main>
</template>

<script setup>
import { onMounted, reactive } from 'vue'

const metrics = reactive([
  { label: '材料维度', target: 6, suffix: '类', display: '0类' },
  { label: '协同端口', target: 4, suffix: '端', display: '0端' },
  { label: '流程留痕', target: 100, suffix: '%', display: '0%' },
  { label: '移动适配', target: 1, suffix: '套', display: '0套' }
])

const capabilities = [
  {
    short: '报',
    tone: 'blue',
    title: '信用报告解读',
    desc: '识别报告结构、账户状态、查询记录、逾期提示和负债结构，输出更清晰的风险摘要。'
  },
  {
    short: '材',
    tone: 'green',
    title: '补充材料管理',
    desc: '支持三金、个税、工资流水、资产证明等材料分组上传，便于后续按材料完整度判断。'
  },
  {
    short: '询',
    tone: 'cyan',
    title: '咨询协同群',
    desc: '客户先进入客服沟通，客服按规则接单，再邀请匹配机构的银行老师进入群聊。'
  },
  {
    short: '档',
    tone: 'yellow',
    title: '管理员留档',
    desc: '客户资料、咨询进度、服务评价和操作记录进入管理端，方便运营和审计。'
  },
  {
    short: '配',
    tone: 'purple',
    title: '产品路径规划',
    desc: '结合报告和补充材料给出可尝试路径，材料不足时优先提示补齐或养护方向。'
  }
]

const flowSteps = [
  { title: '上传信用报告', desc: '用户上传本人征信 PDF 或截图，系统先做报告归属和结构校验。' },
  { title: '补齐关键材料', desc: '根据工资、三金、个税、资产等情况补充材料，缺失项可以明确选择暂无。' },
  { title: '生成路径建议', desc: '系统按材料完整度输出问题、风险和可沟通方向，不把单份报告直接当作最终匹配。' },
  { title: '进入人工协同', desc: '客户与客服沟通，客服确认后再按权限邀请银行老师，管理员保留完整留档。' }
]

const liveEvents = [
  '报告结构校验完成',
  '补充材料等待客户确认',
  '客服已接单并创建会话',
  '管理员端同步服务记录'
]

const roles = [
  { tag: '客户端', title: '只看自己的资料和服务进度', desc: '上传报告、补充材料、发起咨询、查看建议、结束或清空本地会话。' },
  { tag: '客服端', title: '接单、沟通、邀请银行老师', desc: '接单后获得该客户材料权限，未接单客户不进入自己的处理列表。' },
  { tag: '银行端', title: '只看匹配本机构的信息', desc: '银行老师经客服确认后进入群聊，只查看与所属机构匹配的客户资料。' },
  { tag: '管理端', title: '全局监测和留档', desc: '查看客户档案、上传材料、群聊进度、评价反馈和运营数据。' }
]

const security = [
  { title: '授权选择上传', desc: '用户主动选择照片或文件，不默认读取全部相册。' },
  { title: '角色权限分级', desc: '不同账号只进入对应端口，敏感资料按角色和接单状态开放。' },
  { title: '管理员留痕', desc: '客户清空本地聊天后，管理端仍按合规需求保留服务记录。' },
  { title: 'Web 发布支持', desc: '官网可承接服务说明、用户协议和浏览器技术支持。' }
]

onMounted(() => {
  const revealNodes = Array.from(document.querySelectorAll('[data-reveal]'))
  const reveal = (node) => node.classList.add('is-visible')

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            reveal(entry.target)
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.16 }
    )
    revealNodes.forEach((node) => observer.observe(node))
  } else {
    revealNodes.forEach(reveal)
  }

  const start = performance.now()
  const duration = 1100

  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)

    metrics.forEach((metric) => {
      const value = Math.max(metric.target === 1 ? 1 : 0, Math.round(metric.target * eased))
      metric.display = `${value}${metric.suffix}`
    })

    if (progress < 1) requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
})
</script>

<style scoped>
.official-site {
  --official-ink: #061b3a;
  --official-muted: #63728a;
  --official-blue: #0872ea;
  --official-cyan: #18b7d9;
  --official-green: #18ad70;
  --official-yellow: #f5ad22;
  --official-border: rgba(194, 215, 242, 0.8);
  --official-surface: rgba(255, 255, 255, 0.82);
  width: 100%;
  min-height: 100vh;
  overflow-x: hidden;
  background: #f4f8ff;
  color: var(--official-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  letter-spacing: 0;
}

.official-site a {
  color: inherit;
  text-decoration: none;
}

.official-nav {
  position: fixed;
  top: 18px;
  left: 50%;
  z-index: 30;
  width: min(1180px, calc(100% - 32px));
  height: 68px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 0 18px;
  border: 1px solid rgba(205, 224, 248, 0.78);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.76);
  box-shadow: 0 18px 45px rgba(27, 70, 124, 0.12);
  backdrop-filter: blur(22px);
  transform: translateX(-50%);
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.brand-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: linear-gradient(145deg, #0f7dff 0%, #0458c7 100%);
  color: #fff;
  font-weight: 900;
  box-shadow: 0 10px 22px rgba(8, 108, 234, 0.24);
}

.brand-text {
  display: grid;
  line-height: 1.15;
}

.brand-text strong {
  font-size: 18px;
  font-weight: 900;
}

.brand-text small {
  margin-top: 4px;
  color: var(--official-muted);
  font-size: 12px;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 28px;
  color: #394b64;
  font-size: 15px;
  font-weight: 700;
}

.nav-links a,
.nav-action,
.primary-action,
.secondary-action {
  transition: transform 180ms ease, border-color 180ms ease, color 180ms ease, background 180ms ease, box-shadow 180ms ease;
}

.nav-links a:hover,
.nav-action:hover,
.primary-action:hover,
.secondary-action:hover {
  transform: translateY(-1px);
}

.nav-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 112px;
  min-height: 42px;
  border-radius: 8px;
  background: var(--official-blue);
  color: #fff;
  font-weight: 800;
  box-shadow: 0 12px 24px rgba(8, 108, 234, 0.22);
}

.official-hero {
  position: relative;
  min-height: 96vh;
  min-height: 96dvh;
  display: grid;
  align-items: center;
  padding: 136px max(28px, calc((100vw - 1180px) / 2)) 86px;
  isolation: isolate;
  overflow: hidden;
  background:
    radial-gradient(circle at 20% 28%, rgba(8, 114, 234, 0.18), transparent 28%),
    radial-gradient(circle at 78% 18%, rgba(24, 183, 217, 0.2), transparent 26%),
    linear-gradient(135deg, #eef7ff 0%, #f9fcff 44%, #e9f3ff 100%);
}

.hero-atmosphere {
  position: absolute;
  inset: 0;
  z-index: -2;
  overflow: hidden;
}

.mesh {
  position: absolute;
  display: block;
  border-radius: 999px;
  filter: blur(28px);
  opacity: 0.72;
  animation: floatMesh 9s ease-in-out infinite alternate;
}

.mesh-a {
  top: 18%;
  left: -80px;
  width: 320px;
  height: 320px;
  background: rgba(8, 108, 234, 0.18);
}

.mesh-b {
  top: 12%;
  right: 6%;
  width: 380px;
  height: 380px;
  background: rgba(24, 183, 217, 0.16);
  animation-delay: -2s;
}

.mesh-c {
  right: 22%;
  bottom: 2%;
  width: 280px;
  height: 280px;
  background: rgba(245, 173, 34, 0.12);
  animation-delay: -4s;
}

.data-line {
  position: absolute;
  height: 1px;
  width: 46vw;
  min-width: 420px;
  background: linear-gradient(90deg, transparent, rgba(8, 108, 234, 0.38), transparent);
  animation: scanLine 4.2s linear infinite;
}

.data-line-a {
  top: 32%;
  left: -24vw;
}

.data-line-b {
  right: -18vw;
  bottom: 26%;
  animation-delay: -1.4s;
}

.hero-visual {
  position: absolute;
  right: max(-150px, calc((100vw - 1360px) / 2));
  bottom: 2%;
  z-index: -1;
  width: min(760px, 58vw);
  max-height: 76vh;
  object-fit: contain;
  opacity: 0.92;
  filter: drop-shadow(0 26px 58px rgba(24, 73, 128, 0.16));
  animation: visualDrift 7s ease-in-out infinite alternate;
}

.hero-visual-text {
  display: grid;
  gap: 14px;
  padding: 26px 30px;
  border: 1px solid rgba(8, 108, 234, 0.2);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.74);
  color: #071b3d;
  font-size: clamp(15px, 1.6vw, 22px);
  font-weight: 800;
  line-height: 1.4;
}

.hero-copy {
  width: min(610px, 100%);
  padding-top: 20px;
}

.eyebrow {
  margin: 0 0 16px;
  color: var(--official-blue);
  font-size: 14px;
  font-weight: 900;
  letter-spacing: 0;
}

.hero-copy h1 {
  margin: 0;
  font-size: clamp(58px, 9vw, 118px);
  line-height: 0.95;
  letter-spacing: 0;
  font-weight: 950;
}

.hero-lead {
  width: min(540px, 100%);
  margin: 26px 0 0;
  color: #33465f;
  font-size: clamp(18px, 2.2vw, 24px);
  line-height: 1.72;
  font-weight: 650;
}

.hero-actions,
.cta-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 34px;
}

.primary-action,
.secondary-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  padding: 0 24px;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 900;
}

.primary-action {
  background: linear-gradient(135deg, #1a95ff 0%, #075fd2 100%);
  color: #fff;
  box-shadow: 0 16px 30px rgba(8, 108, 234, 0.24);
}

.secondary-action {
  border: 1px solid rgba(139, 168, 205, 0.58);
  background: rgba(255, 255, 255, 0.72);
  color: var(--official-ink);
}

.secondary-action.light {
  border-color: rgba(255, 255, 255, 0.62);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.hero-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 28px;
}

.hero-badges span {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 14px;
  border: 1px solid rgba(182, 210, 242, 0.86);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.68);
  color: #39516d;
  font-size: 14px;
  font-weight: 800;
}

.hero-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  width: min(780px, 100%);
  margin-top: 70px;
}

.metric-tile,
.capability-card,
.role-card,
.live-panel {
  border: 1px solid var(--official-border);
  border-radius: 8px;
  background: var(--official-surface);
  box-shadow: 0 18px 44px rgba(31, 74, 128, 0.08);
  backdrop-filter: blur(16px);
}

.metric-tile {
  padding: 18px;
}

.metric-tile strong {
  display: block;
  color: var(--official-ink);
  font-size: clamp(26px, 3.5vw, 40px);
  line-height: 1;
  font-weight: 950;
}

.metric-tile span {
  display: block;
  margin-top: 9px;
  color: var(--official-muted);
  font-size: 14px;
  font-weight: 800;
}

.section-band {
  padding: 108px max(24px, calc((100vw - 1180px) / 2));
}

.light-band {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.9), rgba(242,248,255,0.98)),
    radial-gradient(circle at 18% 20%, rgba(24,183,217,0.12), transparent 28%);
}

.flow-band {
  background: linear-gradient(135deg, #061b3a 0%, #0b2d5f 64%, #084b9c 100%);
  color: #fff;
}

.role-band {
  background: #f7fbff;
}

.security-band {
  background:
    radial-gradient(circle at 82% 18%, rgba(24, 173, 112, 0.12), transparent 28%),
    linear-gradient(180deg, #ffffff 0%, #edf6ff 100%);
}

.section-inner {
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
}

.section-heading {
  width: min(760px, 100%);
}

.section-heading.compact {
  width: min(500px, 100%);
}

.section-heading h2,
.cta-copy h2 {
  margin: 0;
  font-size: clamp(32px, 4.8vw, 56px);
  line-height: 1.16;
  letter-spacing: 0;
  font-weight: 950;
}

.section-heading p:not(.eyebrow),
.cta-copy p:not(.eyebrow) {
  margin: 18px 0 0;
  color: var(--official-muted);
  font-size: 17px;
  line-height: 1.78;
}

.flow-band .section-heading p:not(.eyebrow) {
  color: rgba(229, 239, 252, 0.8);
}

.capability-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  margin-top: 44px;
}

.capability-card {
  min-height: 230px;
  padding: 26px;
}

.capability-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #fff;
  font-weight: 950;
}

.capability-icon.blue { background: var(--official-blue); }
.capability-icon.green { background: var(--official-green); }
.capability-icon.cyan { background: var(--official-cyan); }
.capability-icon.yellow { background: var(--official-yellow); }
.capability-icon.purple { background: #7c3aed; }
.capability-icon.ink { background: var(--official-ink); }

.capability-card h3,
.role-card h3,
.flow-step h3 {
  margin: 22px 0 0;
  color: var(--official-ink);
  font-size: 22px;
  line-height: 1.26;
  font-weight: 950;
}

.capability-card p,
.role-card p,
.flow-step p {
  margin: 12px 0 0;
  color: var(--official-muted);
  font-size: 15px;
  line-height: 1.76;
}

.flow-layout {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(420px, 1.1fr);
  grid-template-areas:
    "copy rail"
    "live rail";
  gap: 34px 56px;
  align-items: start;
}

.flow-layout .section-heading {
  grid-area: copy;
}

.flow-rail {
  grid-area: rail;
  position: relative;
  display: grid;
  gap: 18px;
}

.flow-rail::before {
  content: "";
  position: absolute;
  top: 26px;
  bottom: 26px;
  left: 25px;
  width: 2px;
  background: linear-gradient(180deg, rgba(94, 194, 255, 0.8), rgba(255, 255, 255, 0.08));
}

.flow-step {
  position: relative;
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 18px;
  padding: 22px;
  border: 1px solid rgba(151, 190, 238, 0.32);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(14px);
}

.step-index {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: #fff;
  color: var(--official-blue);
  font-size: 22px;
  font-weight: 950;
  box-shadow: 0 14px 26px rgba(0, 0, 0, 0.12);
}

.flow-step h3 {
  margin-top: 0;
  color: #fff;
}

.flow-step p {
  color: rgba(229, 239, 252, 0.82);
}

.live-panel {
  grid-area: live;
  padding: 22px;
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(151, 190, 238, 0.32);
}

.live-header {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #fff;
}

.pulse-dot {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: #20d98e;
  box-shadow: 0 0 0 rgba(32, 217, 142, 0.42);
  animation: pulseDot 1.8s ease-out infinite;
}

.live-panel ul {
  display: grid;
  gap: 12px;
  margin: 18px 0 0;
  padding: 0;
  list-style: none;
}

.live-panel li {
  color: rgba(229, 239, 252, 0.84);
  font-size: 15px;
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-top: 44px;
}

.role-card {
  padding: 24px;
  background: #fff;
}

.role-card span {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  background: #eaf3ff;
  color: var(--official-blue);
  font-size: 13px;
  font-weight: 900;
}

.security-layout {
  display: grid;
  grid-template-columns: minmax(0, 0.86fr) minmax(360px, 1.14fr);
  gap: 56px;
  align-items: start;
}

.security-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.security-item {
  min-height: 150px;
  padding: 24px;
  border: 1px solid var(--official-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.8);
}

.security-item strong {
  display: block;
  color: var(--official-ink);
  font-size: 19px;
  font-weight: 950;
}

.security-item span {
  display: block;
  margin-top: 12px;
  color: var(--official-muted);
  font-size: 15px;
  line-height: 1.7;
}

.official-cta {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 36px;
  align-items: center;
  padding: 88px max(24px, calc((100vw - 1180px) / 2));
  color: #fff;
  background:
    radial-gradient(circle at 12% 20%, rgba(24, 183, 217, 0.28), transparent 28%),
    linear-gradient(135deg, #061b3a 0%, #063c83 100%);
}

.cta-copy {
  width: min(760px, 100%);
}

.cta-copy .eyebrow {
  color: #8adfff;
}

.cta-copy p:not(.eyebrow) {
  color: rgba(234, 243, 255, 0.82);
}

[data-reveal] {
  opacity: 0;
  transform: translateY(22px);
  transition: opacity 720ms ease, transform 720ms ease;
}

[data-reveal].is-visible {
  opacity: 1;
  transform: translateY(0);
}

@keyframes floatMesh {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to { transform: translate3d(24px, -18px, 0) scale(1.06); }
}

@keyframes visualDrift {
  from { transform: translate3d(0, 0, 0) rotate(-1deg); }
  to { transform: translate3d(-10px, -14px, 0) rotate(1deg); }
}

@keyframes scanLine {
  from { transform: translateX(0); opacity: 0; }
  22% { opacity: 1; }
  80% { opacity: 1; }
  to { transform: translateX(72vw); opacity: 0; }
}

@keyframes pulseDot {
  from { box-shadow: 0 0 0 0 rgba(32, 217, 142, 0.42); }
  to { box-shadow: 0 0 0 16px rgba(32, 217, 142, 0); }
}

@media (max-width: 980px) {
  .official-nav {
    top: 12px;
    height: 60px;
    width: calc(100% - 24px);
    padding: 0 12px;
  }

  .brand-text small,
  .nav-links {
    display: none;
  }

  .nav-action {
    min-width: 92px;
    min-height: 40px;
    font-size: 14px;
  }

  .official-hero {
    min-height: auto;
    padding: 108px 20px 54px;
  }

  .hero-visual {
    position: relative;
    right: auto;
    bottom: auto;
    z-index: 0;
    width: min(680px, 112%);
    max-height: none;
    margin: 34px -6% 0;
    order: 2;
  }

  .hero-copy {
    padding-top: 0;
  }

  .hero-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-top: 28px;
  }

  .capability-grid,
  .role-grid,
  .security-list {
    grid-template-columns: 1fr;
  }

  .flow-layout,
  .security-layout,
  .official-cta {
    grid-template-columns: 1fr;
  }

  .flow-layout {
    grid-template-areas:
      "copy"
      "rail"
      "live";
  }

  .section-band,
  .official-cta {
    padding: 72px 20px;
  }
}

@media (max-width: 560px) {
  .official-nav {
    border-radius: 8px;
  }

  .brand-mark {
    width: 38px;
    height: 38px;
  }

  .hero-copy h1 {
    font-size: 64px;
  }

  .hero-lead {
    font-size: 17px;
  }

  .primary-action,
  .secondary-action {
    width: 100%;
  }

  .hero-badges span {
    flex: 1 1 calc(50% - 10px);
    justify-content: center;
    white-space: nowrap;
  }

  .metric-tile {
    padding: 16px;
  }

  .capability-card,
  .role-card,
  .security-item,
  .flow-step {
    padding: 20px;
  }

  .flow-step {
    grid-template-columns: 44px 1fr;
  }

  .step-index {
    width: 44px;
    height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 1ms !important;
  }
}
</style>
