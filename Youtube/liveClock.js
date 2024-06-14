// ==UserScript==
// @name               Youtube Live Clock
// @name:zh-TW         Youtube Live Clock
// @namespace          https://greasyfork.org/scripts/453367
// @version            1.6.5
// @description        show duration for livestreams and present time for archives
// @description:zh-TW  顯示直播及直播存檔當下的時間
// @author             Derek
// @match              *://www.youtube.com/*
// @grant              none
// ==/UserScript==

//you can choose your ideal date format by changing the FORMAT's value below
const FORMAT = 1
/*
  1: 2022/10/31 06:37:10
  2: 10/31/2022 06:37:10
  3: 31/10/2022 06:37:10
  4: Mon 31/10/2022 06:37:10
  5: Monday 31/10/2022 06:37:10
*/

const $ = (element) => document.querySelector(element)

const abbr = {
  week: { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' },
  month: { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December' }
}

const twoDigit = (num) => num.toString().padStart(2, '0')

const timeFormat = (time) => {
  const second = time % 60
  const minute = Math.floor((time / 60) % 60)
  const hour = Math.floor(time / 3600)
  return hour > 0 ? `${hour}:${twoDigit(minute)}:${twoDigit(second)}` : `${minute}:${twoDigit(second)}`
}

const dateFormat = (presentTime) => {
  const [week, , day, year, time] = presentTime.toString().split(' ')
  const month = twoDigit(presentTime.getMonth() + 1)
  return {
    1: ` (${year}/${month}/${day} ${time})`,
    2: ` (${month}/${day}/${year} ${time})`,
    3: ` (${day}/${month}/${year} ${time})`,
    4: ` (${week} ${day}/${month}/${year} ${time})`,
    5: ` (${abbr.week[week]} ${day}/${month}/${year} ${time})`
  } [FORMAT]
}

let liveBadge = null
let timeDisplay = null
let progressBar = null

const waitElements = () => {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      liveBadge = $('.ytp-live-badge')
      timeDisplay = $('.ytp-time-display')
      progressBar = $('.ytp-progress-bar')
      if (liveBadge && timeDisplay && progressBar) {
        observer.disconnect()
        resolve()
      }
    })
    observer.observe(document.body, { attributes: false, childList: true, subtree: true })
  })
}

const getLiveClock = () => {
  let clockElement = $('#present-time')
  if (!clockElement) {
    clockElement = document.createElement('span')
    clockElement.setAttribute('id', 'present-time')
    timeDisplay.childNodes[1].appendChild(clockElement)
  }
  return clockElement
}

const updateLiveTime = () => {
  if (!$('#microformat script')) return ''
  let liveData = JSON.parse($('#microformat script').textContent)
  if (liveData.publication) {
    liveData = liveData.publication[0]
    const progressTime = progressBar.getAttribute('aria-valuenow')
    return liveData.endDate ? dateFormat(new Date(Date.parse(liveData.startDate) + progressTime * 1000)) : timeFormat(progressTime)
  } else return ''
}

const main = async () => {
  await waitElements()
  liveBadge.style = 'margin-left: 10px'
  let liveClock = getLiveClock()
  const observer = new MutationObserver(() => { liveClock.textContent = updateLiveTime() })
  observer.observe(progressBar, { characterData: true, attributeFilter: ['aria-valuenow'] })
}

document.addEventListener('yt-navigate-finish', (event) => {
  if (event.detail.endpoint.commandMetadata.webCommandMetadata.url.startsWith('/watch?v=')) main()
})
