# Script

個人使用的 Tampermonkey userscripts,主要針對 YouTube / Twitch 的觀影體驗調整。

## 安裝

瀏覽器安裝 [Tampermonkey](https://www.tampermonkey.net/) 後,點下方腳本連結即可安裝;各腳本彼此獨立,可只裝需要的。更新採手動。

## 腳本清單

| 腳本 | 對象 | 功能 |
|---|---|---|
| [YouTubePlayerTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubePlayerTweaks.js) | YouTube | 播放器加截圖鍵(`S`)、滾輪調音量/播放速度、直播追平(1.5x 追到最低延遲);解鎖無 DVR 直播的回看,並將回看視窗放寬到 7 天 |
| [YouTubeLiveClock](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveClock.js) | YouTube | 直播顯示經過時間,直播存檔顯示當下時間點的絕對時刻 |
| [YouTubeLiveLayout](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveLayout.js) | YouTube | 一般影片不動;無聊天室的劇院模式滿版;有聊天室時用 75/25 劇院版面 |
| [YouTubeLiveChatTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.js) | YouTube 聊天室 | 版面精簡、表情複製帶完整名稱、重新載入按鈕、自動跟隨最新訊息(手動上捲時暫停) |
| [YouTubeAutoDisableSubtitles](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeAutoDisableSubtitles.js) | YouTube | 進入影片自動關閉字幕 |
| [YouTubeDefaultMaxQuality](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeDefaultMaxQuality.js) | YouTube | 自動切到最高畫質 |
| [YouTubeChannelAutoPause](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeChannelAutoPause.js) | YouTube | 頻道頁自動暫停自動播放的預告影片 |
| [TwitchPlayerTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchPlayerTweaks.js) | Twitch | 隱藏剪輯按鈕與互動擴充、截圖按鈕、滾輪調音量、原生風格 tooltip |
| [pixiv](https://raw.githubusercontent.com/rtashklzx47277/Script/main/pixiv.js) | Pixiv | `jump.php` 跳轉頁直接前往目標網址 |

`Other/` 內另有幾支站點腳本,不納入版控。

## 設定

- **YouTubeLiveClock**:改檔頭的 `FORMAT` 常數(1–6)切換日期格式,選項見檔內註解。
- **YouTubeLiveLayout**:`PRIMARY_RATIO` 控制播放器與聊天室的寬度比(預設 0.75)。
- **YouTubePlayerTweaks**:`MAX_DVR_SECONDS` 為 DVR 回看上限(預設 7 天);`LIVE_CATCHUP_RATE` / `LIVE_CATCHUP_TARGET_BUFFER` 控制追直播的速度與目標緩衝秒數。

## 腳本間的關聯與已知取捨

- **LiveClock 依賴 PlayerTweaks 的 DVR 解鎖**:直播「經過時間」取自進度條位置,只有在 DVR 視窗涵蓋整場直播時才等於真實經過時間;超過 13 小時的直播需要 PlayerTweaks 放寬的回看視窗才準確。
- **字幕功能分工**:PlayerTweaks 用 CSS 隱藏字幕「按鈕」,AutoDisableSubtitles 負責關閉字幕「狀態」,兩者互補而非重複。
- **PlayerTweaks 會覆寫頁面的 `JSON.parse` 並攔截 `ytInitialPlayerResponse`**:這是 player response 送達的僅有兩條路徑。副作用:接手 `ytInitialPlayerResponse` 後,先前掛在該屬性上的其他攔截器(如 uBO scriptlet)之後的 setter 只會被通知一次。
- 所有腳本都依賴 YouTube / Twitch 的內部 DOM 結構與非公開 API,**上游改版隨時可能使功能失效**,失效模式以「靜默不動作」為主,不會弄壞頁面本身。

## 版本

行為變更時遞增各腳本的 `@version`。

## 授權

尚未指定授權條款(預設保留所有權利)。
