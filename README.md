# Script

個人使用的 Tampermonkey userscripts,主要針對 YouTube / Twitch 的觀影體驗調整。

## 安裝

瀏覽器安裝 [Tampermonkey](https://www.tampermonkey.net/) 後,點下方腳本連結即可安裝;各腳本彼此獨立,可只裝需要的。安裝後由 Tampermonkey 自動檢查更新。

## 腳本清單

| 腳本 | 對象 | 功能 |
|---|---|---|
| [YouTubePlayerTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubePlayerTweaks.user.js) | YouTube | 播放器加截圖鍵(`S`)、滾輪調音量/播放速度、直播追平(1.5x 追到最低延遲);解鎖無 DVR 直播的回看,並將回看視窗放寬到 7 天 |
| [YouTubeLiveClock](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveClock.user.js) | YouTube | 直播顯示經過時間,直播存檔顯示當下時間點的絕對時刻 |
| [YouTubeLiveLayout](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveLayout.user.js) | YouTube | 一般模式不改動版面;無聊天室時將劇院模式滿版;有聊天室時使用響應式劇院版面,窄視窗將聊天室排在影片下方 |
| [YouTubeLiveChatTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.user.js) | YouTube 聊天室 | 版面精簡、表情複製帶完整名稱、重新載入按鈕、自動跟隨最新訊息(手動上捲時暫停) |
| [YouTubeAutoDisableSubtitles](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeAutoDisableSubtitles.user.js) | YouTube | 進入影片自動關閉字幕 |
| [YouTubeDefaultMaxQuality](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeDefaultMaxQuality.user.js) | YouTube | 自動切到最高畫質 |
| [YouTubeChannelAutoPause](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeChannelAutoPause.user.js) | YouTube | 頻道頁自動暫停自動播放的預告影片 |
| [TwitchPlayerTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchPlayerTweaks.user.js) | Twitch | 隱藏剪輯按鈕與互動擴充、截圖按鈕、滾輪調音量、原生風格 tooltip |
| [pixiv](https://raw.githubusercontent.com/rtashklzx47277/Script/main/pixiv.user.js) | Pixiv | `jump.php` 跳轉頁直接前往目標網址 |

`Other/` 內另有幾支站點腳本,不納入版控。

## 書籤小工具

**Hololyzer Superchat**:在 YouTube 影片 / 直播頁按下,於新分頁開啟該影片的 [Hololyzer](https://hololyzer.net/) 即時 Superchat 統計;非影片 / 直播頁則跳提示。

新增書籤,網址欄貼上:

```
javascript:(()=>{const m=/(^|\.)(youtube\.com|youtu\.be)$/.test(location.hostname)&&location.href.match(/(?:[?&]v=|\/(?:live|embed|shorts)\/|youtu\.be\/)([\w-]{11})/);m?open('https://hololyzer.net/kojin/realtime/superchat/'+m[1]+'.html'):alert('這不是 YouTube 影片 / 直播頁面')})()
```

支援 `watch?v=`、`/live/`、`/embed/`、`/shorts/` 與 `youtu.be` 短網址。

## 設定

- **YouTubeLiveClock**:改檔頭的 `FORMAT` 常數(1–6)切換日期格式,選項見檔內註解。
- **YouTubeLiveLayout**:`PRIMARY_RATIO` 控制寬視窗中播放器與聊天室的寬度比(預設 0.75);頁面寬度低於螢幕可用寬度的 `MAX_STACKED_VIEWPORT_RATIO`(預設 0.75),且側欄低於 `MIN_SIDE_CHAT_WIDTH`(預設 400px)時,聊天室改排在影片正下方並使用完整寬度。
- **YouTubePlayerTweaks**:`MAX_DVR_SECONDS` 為 DVR 回看上限(預設 7 天);`LIVE_CATCHUP_RATE` 控制追直播速度,`LIVE_CATCHUP_TARGET_DELAY` 為距直播端的目標秒數,`LIVE_CATCHUP_TARGET_BUFFER` 為停止加速的緩衝門檻。抵達直播端、緩衝不足或播放停滯時會結束追平;直播端位置暫時無法取得時可依緩衝狀態追平。

## 腳本間的關聯與已知取捨

- **LiveClock 依賴 PlayerTweaks 的 DVR 解鎖**:直播「經過時間」取自進度條位置,只有在 DVR 視窗涵蓋整場直播時才等於真實經過時間;超過 13 小時的直播需要 PlayerTweaks 放寬的回看視窗才準確。
- **字幕功能分工**:PlayerTweaks 用 CSS 隱藏字幕「按鈕」,AutoDisableSubtitles 負責關閉字幕「狀態」,兩者互補而非重複。
- **YouTube / Twitch 截圖**:播放器就緒後預先啟動背景編碼 Worker,截圖保留原解析度 PNG,剪貼簿與下載共用同一份圖片。PNG 完成後直接由瀏覽器下載,省去 Tampermonkey 下載流程的等待;檔案存到瀏覽器設定的下載位置,不再自動放入 `ScreenShot/` 子資料夾。不支援相關瀏覽器功能時自動使用相容流程;PNG 編碼與瀏覽器存檔仍需要時間。
- **PlayerTweaks 會覆寫頁面的 `JSON.parse` 並攔截 `ytInitialPlayerResponse`**:這是 player response 送達的僅有兩條路徑。副作用:接手 `ytInitialPlayerResponse` 後,先前掛在該屬性上的其他攔截器(如 uBO scriptlet)之後的 setter 只會被通知一次。
- 所有腳本都依賴 YouTube / Twitch 的內部 DOM 結構與非公開 API,**上游改版隨時可能使功能失效**,失效模式以「靜默不動作」為主,不會弄壞頁面本身。

## 本機驗證

使用 Node.js 內建測試工具,不需要安裝額外套件:

```sh
node --test tests/*.test.cjs
```

測試涵蓋播放器追平與速度恢復、截圖 Worker 及失敗回退、SPA 導覽與等待清理、聊天室跟隨、時鐘重建、版面初始化、字幕與畫質就緒、網址跳轉,以及 `Other/` 的圖片和側欄操作。`Other/` 不在版控中,缺少這些本機腳本時會略過對應測試。

測試在 Node.js VM 中模擬瀏覽器 API;實際網站 DOM、CSS 排版、剪貼簿權限與 PNG 像素仍需在瀏覽器驗證。

## 版本

行為變更時遞增各腳本的 `@version`。

## 授權

尚未指定授權條款(預設保留所有權利)。
