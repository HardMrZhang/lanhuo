// 生成大量 mock 短剧数据到 data/dramas.json（覆盖各分类，可正常播放的公开测试源）。
// 用法: node scripts/gen-mock.mjs [每分类数量，默认 12]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../data/dramas.json')
const PER_CAT = Number(process.argv[2]) || 12

const categories = [
  { id: 'urban', name: '都市' },
  { id: 'romance', name: '甜宠' },
  { id: 'costume', name: '古装' },
  { id: 'suspense', name: '悬疑' },
  { id: 'comeback', name: '逆袭' },
  { id: 'anime', name: '漫剧' },
  { id: 'fantasy', name: '玄幻' },
  { id: 'family', name: '家庭' },
]

// 每分类的剧名词库（前缀 + 后缀组合）
const words = {
  urban: [['都市', '总裁', '豪门', '重生', '天才', '神医'], ['归来', '的秘密', '风云', '之巅', '人生', '游戏']],
  romance: [['甜宠', '闪婚', '错嫁', '暖婚', '蜜爱', '心动'], ['小娇妻', '99次', '进行时', '宠上天', '限定', '信号']],
  costume: [['凤华', '锦绣', '嫡女', '宫墙', '将军', '医妃'], ['权谋', '未央', '为后', '策', '天下', '传奇']],
  suspense: [['迷雾', '深夜', '第十三', '沉默', '暗河', '罪案'], ['追凶', '来电', '号病房', '的真相', '疑云', '档案']],
  comeback: [['最强', '开局', '废柴', '扮猪', '神级', '龙王'], ['赘婿', '签到', '逆袭', '吃虎', '归来', '殿下']],
  anime: [['异世界', '魔法', '像素', '机甲', '国漫', '幻境'], ['纪元', '少女', '战记', '编年史', '召唤', '之门']],
  fantasy: [['九天', '苍穹', '斗破', '仙域', '万古', '神墓'], ['神帝', '之上', '霸主', '战神', '第一', '重生']],
  family: [['幸福', '人间', '妈妈', '岁月', '烟火', '我们'], ['一家人', '烟火气', '再爱一次', '如歌', '向前冲', '的日子']],
}

const tagsPool = ['爽文', '反转', '虐恋', '先婚后爱', '马甲', '打脸', '追妻', '团宠', '无脑爽', '强强', '高甜', '悬疑烧脑', '穿越', '重生', '腹黑', '双洁']

// 可正常播放的公开测试视频源（循环使用）
const HLS = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://test-streams.mux.dev/pts_shift/master.m3u8',
  'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
]
const MP4 = [
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/VolkswagenGTIReview.mp4',
]

// 稳定伪随机，保证每次生成结果一致
let seed = 20260917
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const int = (min, max) => min + Math.floor(rand() * (max - min + 1))

const usedTitles = new Set()
function makeTitle(catId) {
  const [pre, suf] = words[catId]
  for (let i = 0; i < 20; i++) {
    const t = pick(pre) + pick(suf)
    if (!usedTitles.has(t)) {
      usedTitles.add(t)
      return t
    }
  }
  return pick(pre) + pick(suf) + int(2, 99)
}

function makeTags() {
  const n = int(2, 3)
  const s = new Set()
  while (s.size < n) s.add(pick(tagsPool))
  return [...s]
}

function makeEpisodes(n, useHls) {
  const eps = []
  for (let i = 1; i <= n; i++) {
    const src = useHls ? HLS[i % HLS.length] : MP4[i % MP4.length]
    eps.push({ no: i, title: `第${i}集`, src })
  }
  return eps
}

const dramas = []
let idx = 0
for (const cat of categories) {
  for (let i = 0; i < PER_CAT; i++) {
    idx++
    const useHls = idx % 3 === 0
    const epCount = pick([16, 20, 24, 30, 40, 60, 80])
    const completed = rand() > 0.35
    // 部分剧挂第二个分类，增加交叉
    const catIds = [cat.id]
    if (rand() > 0.6) {
      const other = pick(categories).id
      if (other !== cat.id) catIds.push(other)
    }
    const daysAgo = int(0, 120)
    dramas.push({
      id: `d${String(idx).padStart(3, '0')}`,
      title: makeTitle(cat.id),
      cover: `https://picsum.photos/seed/dj${idx}/480/270`,
      description:
        '这是一部用于演示的短剧简介，讲述主角在命运转折中逆风翻盘的故事，节奏紧凑、反转不断，适合碎片时间观看。剧情纯属虚构，仅用于界面演示。',
      categoryIds: catIds,
      tags: makeTags(),
      status: completed ? 'completed' : 'ongoing',
      hd: rand() > 0.4,
      views: int(1, 5000) * 1000,
      rating: int(70, 99),
      publishedAt: new Date(Date.now() - daysAgo * 864e5).toISOString(),
      episodes: makeEpisodes(epCount, useHls),
    })
  }
}

fs.writeFileSync(OUT, JSON.stringify({ categories, dramas }, null, 2) + '\n')
console.log(`已生成 ${dramas.length} 部短剧 → ${path.relative(process.cwd(), OUT)}`)
