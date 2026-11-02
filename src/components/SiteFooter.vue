<script setup lang="ts">
import { contentChannels } from '../navigation'
import { tr } from '../i18n'
</script>

<template>
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-col about">
        <h3>About</h3>
        <ul>
          <li>
            <router-link to="/vip">{{ tr('会员服务协议', 'Membership Service Agreement') }}</router-link>
          </li>
          <li>
            <router-link :to="{ path: '/', query: { view: 'addresses' } }">{{
              tr('官方地址', 'Official Address')
            }}</router-link>
          </li>
          <li>
            <router-link :to="{ path: '/', query: { view: 'tags' } }">{{ tr('标签榜', 'Tags') }}</router-link>
          </li>
          <li>
            <router-link :to="{ path: '/', query: { view: 'ranking' } }">{{
              tr('热播排行榜', 'Trending')
            }}</router-link>
          </li>
        </ul>
      </div>
      <div class="footer-col">
        <h3>{{ tr('热门分类', 'Genres') }}</h3>
        <ul>
          <li v-for="channel in contentChannels.slice(0, 5)" :key="channel.id">
            <router-link :to="{ path: '/', query: { channel: channel.id } }">{{ channel.name }}</router-link>
          </li>
        </ul>
      </div>
      <div class="footer-col">
        <h3>{{ tr('发现好剧', 'Discover') }}</h3>
        <ul>
          <li>
            <router-link :to="{ path: '/', query: { view: 'all', sort: 'new' } }">{{
              tr('最新上架', 'New Releases')
            }}</router-link>
          </li>
          <li>
            <router-link :to="{ path: '/', query: { view: 'all', sort: 'rating' } }">{{
              tr('高分好剧', 'Top Rated')
            }}</router-link>
          </li>
          <li>
            <router-link :to="{ path: '/', query: { search: '1' } }">{{
              tr('搜索短剧', 'Search Dramas')
            }}</router-link>
          </li>
        </ul>
      </div>
      <div class="footer-col">
        <h3>{{ tr('我的剧场', 'My Theater') }}</h3>
        <ul>
          <li><router-link to="/vip">{{ tr('VIP 会员中心', 'VIP Membership') }}</router-link></li>
          <li>
            <router-link :to="{ path: '/', query: { view: 'favorites' } }">{{
              tr('我的追剧', 'My List')
            }}</router-link>
          </li>
          <li>
            <router-link :to="{ path: '/', query: { view: 'history' } }">{{
              tr('观看记录', 'Watch History')
            }}</router-link>
          </li>
        </ul>
      </div>
      <div class="footer-col">
        <h3>{{ tr('联系我们', 'Contact Us') }}</h3>
        <ul>
          <li><a href="mailto:support@example.com">support@example.com</a></li>
          <li><a href="mailto:business@example.com">business@example.com</a></li>
        </ul>
        <h3 class="community">{{ tr('关注我们', 'Community') }}</h3>
        <div class="socials">
          <span aria-hidden="true">f</span>
          <span aria-hidden="true">▶</span>
          <span aria-hidden="true">◎</span>
          <span aria-hidden="true">♪</span>
        </div>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© {{ new Date().getFullYear() }} {{ tr('短剧剧场', 'Drama Theater') }}</span>
      <span>{{ tr('精选剧集 · 精彩故事，随心发现', 'Great dramas. Stories worth discovering.') }}</span>
    </div>
  </footer>
</template>

<style scoped>
.site-footer {
  margin-top: 20px;
  padding: 32px 0 calc(20px + var(--safe-bottom));
  background: var(--footer);
  border-top: 1px solid var(--border);
  color: var(--fg-2);
  font-size: 16px;
}
.footer-inner {
  width: 80vw;
  max-width: 1233px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 32px;
  line-height: 1.6;
}
h3 {
  margin: 0 0 8px;
  color: #fff;
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
}
h3.community {
  margin-top: 22px;
}
ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
li {
  margin-bottom: 8px;
  line-height: 24px;
}
li a {
  color: var(--fg-3);
  font-size: 16px;
  line-height: 24px;
  transition: color 0.2s;
  overflow-wrap: anywhere;
}
li a:hover {
  color: rgba(255, 255, 255, 0.6);
}
.socials {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.socials span {
  display: grid;
  place-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.6);
  font-size: 15px;
}
.footer-bottom {
  width: 80vw;
  max-width: 1233px;
  margin: 24px auto 0;
  padding-top: 18px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  gap: 16px;
  color: var(--fg-3);
  font-size: 14px;
}
@media (max-width: 1200px) {
  .footer-inner {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 768px) {
  .site-footer {
    padding-top: 24px;
  }
  .footer-inner {
    width: auto;
    padding: 0 16px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 24px;
  }
  h3 {
    font-size: 16px;
  }
  li a {
    font-size: 14px;
  }
  .footer-bottom {
    width: auto;
    padding: 16px 16px 0;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
  }
}
</style>
