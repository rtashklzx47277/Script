# Script

個人使用的 Tampermonkey userscripts,主要針對 YouTube / Twitch 的觀影體驗調整。

## 安裝

瀏覽器安裝 [Tampermonkey](https://www.tampermonkey.net/) 後,點下方腳本連結即可安裝;各腳本彼此獨立,可只裝需要的。安裝後由 Tampermonkey 自動檢查更新。

## 腳本清單

| 腳本 | 對象 | 功能 |
|---|---|---|
| [YouTubePlayerTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubePlayerTweaks.user.js) | YouTube | 播放器加截圖鍵(`S`)、滾輪調音量(含 Shorts)/播放速度、直播追平(1.5x 追到最低延遲);解鎖無 DVR 直播的回看,並將回看視窗放寬到 7 天 |
| [YouTubeLiveClock](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveClock.user.js) | YouTube | 直播顯示經過時間,直播存檔顯示當下時間點的絕對時刻 |
| [YouTubeLiveLayout](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveLayout.user.js) | YouTube | 一般模式不改動版面;無聊天室時將劇院模式滿版;有聊天室時使用響應式劇院版面,窄視窗將聊天室排在影片下方 |
| [YouTubeLiveChatTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeLiveChatTweaks.user.js) | YouTube 聊天室 | 隱藏聊天模式選單、Broadcaster／Moderator 與帳號包含／排除篩選、本次頁面紀錄、表情複製、重新載入、自動跟隨最新訊息 |
| [YouTubeAutoDisableSubtitles](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeAutoDisableSubtitles.user.js) | YouTube | 進入影片自動關閉字幕 |
| [YouTubeDefaultMaxQuality](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeDefaultMaxQuality.user.js) | YouTube | 自動切到最高畫質 |
| [YouTubeChannelAutoPause](https://raw.githubusercontent.com/rtashklzx47277/Script/main/YouTubeChannelAutoPause.user.js) | YouTube | 頻道頁自動暫停自動播放的預告影片 |
| [TwitchPlayerTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchPlayerTweaks.user.js) | Twitch | 隱藏剪輯按鈕與互動擴充、截圖按鈕、滾輪調音量、原生風格 tooltip |
| [TwitchLiveChatTweaks](https://raw.githubusercontent.com/rtashklzx47277/Script/main/TwitchLiveChatTweaks.user.js) | Twitch 聊天室 | 上方篩選按鈕切換一般／指定用戶聊天室，保留管理員、頻道主及指定帳號的本次頁面發言紀錄；直接在篩選視窗內管理目標用戶 |
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

- **Shorts 音量**:游標在影片範圍內時,滾輪向上加 5、向下減 5(0–100);影片外維持原本的捲動/切片行為。`Ctrl` + 滾輪保留瀏覽器縮放。
- **YouTubeLiveClock**:改檔頭的 `FORMAT` 常數(1–6)切換日期格式,選項見檔內註解。
- **YouTubeLiveChatTweaks**:上方漏斗按鈕位於「…」右側，開啟篩選時顯示藍色、關閉時恢復原色；漏斗與重新載入按鈕使用原生圓形 hover 且不顯示提示框。「…」選單依聊天室視窗限制寬高。漏斗切換一般／篩選聊天室，隱藏原本「トップチャット／チャット」選單，介面沿用 YouTube 聊天室的主題配色。上方只顯示「目標用戶」與訊息數；展開「目標用戶」會填滿聊天訊息區，Broadcaster／Moderator 選項與帳號管理都放在其中，收合後恢復訊息。在「目標用戶」中選「＋ 包含」或「－ 排除」，每次新增一個 YouTube 頻道 ID（`UC…`）、`/channel/UC…` 完整網址或 `@handle`；頻道 ID 保留大小寫，依發言者 ID 比對，改名不影響篩選。原有中文與日文帳號仍可使用，排除條件優先於角色與包含名單。名單依頻道儲存在瀏覽器；已從嵌入聊天室辨識過頻道的影片，其彈出聊天室會共用設定，無法辨識頻道時則依影片或聊天室分開。紀錄僅保留本次頁面中已載入的訊息，每頻道最多 2,000 則、最近 5 個頻道；重新整理清空，回放以訊息 ID 去重。切回一般聊天室仍持續收集；手動上捲暫停跟隨，按「回到最新訊息」恢復。新增按鈕有明確底色與外框，並與輸入框等高；兩平台都使用 30px 高、4px 圓角的矩形。一般訊息預留右側選項按鈕空間；只有點訊息旁的「…」才開啟報告／封鎖選單，點文字不開啟，連結仍可使用；訊息選項按鈕置中對齊第一列。訊息與上方選單展開時，第一次點外部只關閉選單，下一次才執行底下的操作，同樣支援點擊嵌入聊天室外側。選單內容仍由 YouTube 原生載入。帳號操作提示 3 秒後自動清除，連續操作會重新計時。原有表情複製與重新載入功能可繼續使用。
- **TwitchLiveChatTweaks**:按聊天室上方社群按鈕旁的漏斗圖示切換篩選模式；上方顯示「目標用戶」與訊息數；展開「目標用戶」會填滿聊天訊息區，Broadcaster／Moderator 選項也移至其中，收合後恢復篩選訊息。選「＋ 包含」管理要顯示的帳號，選「－ 排除」管理不要顯示的帳號。排除名單優先於 Broadcaster、Moderator 及包含名單，即使該帳號符合其他條件也不會顯示。可新增、搜尋及逐一移除帳號；每次填一個 Twitch 英文登入帳號後按「新增」，多個帳號或無效輸入不會加入。新增與搜尋的標籤和輸入框排在同一行，新增按鈕與輸入框等高、上下對齊，並與 YouTube 使用相同的 30px 高、4px 圓角矩形，目標用戶區可收合以留出聊天空間；帳號操作提示 3 秒後自動清除，連續操作會重新計時。設定依頻道儲存在瀏覽器，並同步到同一瀏覽器中已開啟的聊天室；切回一般聊天室仍持續收集管理員、頻道主與已指定帳號的訊息，保留表情與徽章。手動上捲暫停跟隨，按「回到最新訊息」恢復。紀錄僅保留本次頁面期間，重新整理清空；每頻道最多 2,000 則，最多保留最近使用的 5 個頻道。無法補抓載入前或指定帳號加入前已從原聊天室移除的發言。另支援 `/popout/帳號/chat` 彈出聊天室。
- **YouTubeLiveLayout**:`PRIMARY_RATIO` 控制寬視窗中播放器與聊天室的寬度比(預設 0.75);頁面寬度低於螢幕可用寬度的 `MAX_STACKED_VIEWPORT_RATIO`(預設 0.75),且側欄低於 `MIN_SIDE_CHAT_WIDTH`(預設 400px)時,聊天室改排在影片正下方並使用完整寬度。
- **YouTubePlayerTweaks**:首次以滾輪或原生滑桿調音量後會啟用音量曲線，原生音量 25/50/100 對應約 12.5/50/200% 的輸出。`MAX_VOLUME_GAIN` 控制最高增益(預設 2 倍)。`MAX_DVR_SECONDS` 為 DVR 回看上限(預設 7 天);`LIVE_CATCHUP_RATE` 控制追直播速度,`LIVE_CATCHUP_TARGET_BUFFER` 為可播放緩衝的追平門檻(預設 0.5 秒)。達到門檻時會停止追平並恢復原本速度。

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

Twitch 篩選聊天室另有 `tests/fixtures/twitch-chat.html` 測試頁，搭配本機靜態伺服器將該頁提供在 `/fixture_channel`，並將新腳本提供在 `/TwitchLiveChatTweaks.user.js`，可驗證指定帳號管理、訊息清理、聊天室重建、頻道切換及跨分頁同步。此頁不會傳送聊天訊息。

YouTube 篩選聊天室有 `tests/fixtures/youtube-chat.html` 測試頁，將該頁提供在 `/live_chat?v=fixture_video`，並提供 `/YouTubeLiveChatTweaks.user.js`，可驗證角色與帳號篩選、排除優先、DOM 清理／重建、單列排版及聊天模式選單隱藏。此頁不會傳送聊天訊息。

## 版本

行為變更時遞增各腳本的 `@version`。

## 授權

尚未指定授權條款(預設保留所有權利)。

`tests/fixtures/youtube-embedded.html` 提供在 `/youtube-embedded`，可驗證點嵌入聊天室外側只關閉選單，第二次才執行外側操作。
