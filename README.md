# duanju-h5

移动端短剧 H5：分类浏览 + 竖屏沉浸播放（上下滑切集），Vue 3 + Vite + hls.js，Node/Express 提供数据与媒体托管。

## 快速开始

```bash
npm install
npm run dev        # 前端 http://localhost:5173 ，后端 http://localhost:3001
```

生产部署：

```bash
npm run build      # 产出 dist/
npm start          # 后端同时托管 dist/ ，访问 http://localhost:3001
```

## 添加你的剧集

1. 编辑 `data/dramas.json`（保存即热重载，不用重启）：
   - `categories`：分类列表
   - `dramas[]`：每部剧的 `id / title / cover / description / categoryIds / tags / status / episodes`
   - `episodes[].src` 支持 `.m3u8`（推荐）或 `.mp4`，可以是本地 `/media/...` 或任意外链
2. 本地视频放到 `media/` 目录，用 `/media/相对路径` 引用。
3. 把 mp4 转成多码率 HLS（弱网不卡的关键）：

```bash
npm run hls -- 输入.mp4 media/剧id/ep01
# 然后 src 填 /media/剧id/ep01/index.m3u8
```

## 流畅播放做了什么

- HLS 自适应码率：弱网自动降到 480p，网络好升回 1080p，不会转圈。
- 只渲染当前集 ±1，同一时刻只解码一路流。
- 播放当前集时预取下一集清单，切集接近秒开。
- 分片 4 秒、前向缓冲 30 秒、后向仅保留 10 秒，内存占用稳定。
- 服务端对 `.ts/.m4s` 分片下发一年 immutable 缓存，二次观看走本地缓存。
- `express.static` 原生支持 Range，mp4 拖动进度条不重下整个文件。

## 目录

```
data/dramas.json     剧集与分类数据
media/               视频文件（不入库）
scripts/to-hls.sh    mp4 → 多码率 HLS
server/              Express API + 静态托管
src/                 Vue 前端
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3001 | 后端端口 |
| `MEDIA_DIR` | `./media` | 媒体目录 |
| `DATA_FILE` | `./data/dramas.json` | 数据文件 |

请只上架你拥有版权或已获授权的内容。
