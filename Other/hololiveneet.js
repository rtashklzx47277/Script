// ==UserScript==
// @name               hololiveneet
// @version            0.1.0
// @description        none
// @author             Derek
// @match              *://bbs.jpnkn.com/test/read.cgi/hololiveneet/*
// @run-at             load
// @grant              none
// @noframes
// ==/UserScript==

let $ = (element) => document.querySelector(element)
let $$ = (element) => document.querySelectorAll(element)

// Add CSS
let style = document.createElement('style')
style.id = 'black-mode'
style.textContent = `
  body,
  .main > * {
    background-color: black !important;
    color: white !important;
  }

  .fixed-top > :first-child,
  .fixed-top > .border-top > :first-child,
  .tgWrite,
	#bottom,
	#pagetop,
	#write {
    display: none !important;
  }

  #thread {
    margin-top: 0 !important;
    padding: 1vh 0 7.5vh !important;
  }

	.tgMenu {
		position: fixed !important;
		bottom: 0 !important;
		width: 100% !important;
  	background-color: black !important;
  	border-top: 1px solid #dee2e6 !important;
	}

  .thumbnail {
    max-width: 80% !important;
    margin: 0.2em !important;
  }

	#pageend {
		background-color: #E0E0E0 !important;
		position: fixed !important;
		bottom: 12px !important;
		right: 12px !important;
		width: 48px !important;
		height: 48px !important;
		margin-bottom: 0px !important;
		text-align: center !important;
		display: block !important;
	}

	#pageend:hover {
		background-color: #BDBDBD !important;
	}

	#tooltip {
		display: none;
		position: fixed !important;
		top: 5vh !important;
		left: 10vw !important;
    background-color: #333333 !important;
		padding: 5px !important;
		border-radius: 5px !important;
		border: 5px solid white !important;
    max-height: 85vh !important;
		max-width: 85vw !important;
		overflow-y: auto !important;
	}

	#tooltip > .media {
		margin: 0px !important;
		border: none !important;
	}

	#tooltip .thumbnail {
		max-width: 75vh !important;
		margin: 0.1em !important;
	}

  .highlight {
    color: black !important;
    background-color: #FFA500 !important;
  }
`
document.head.appendChild(style)

// Highlight Keyword
let counter = 0

document.body.innerHTML = document.body.innerHTML.replace(new RegExp(
	["あくあ", "あくたん", "あくきん", "あてぃし", "あくシオ", "あくしお", "あくすい", "あくみこ", "みなきり", "あくおか", "あくころ", "あくぺこ", "あくトワ", "\\( \\^\\)o\\(\\^ \\)"]
		.join('|'), 'g'), match => {
			return `<span class="highlight" index="match-${++counter}">${match}</span>`
		})

let now = 0

document.onkeydown = (event) => {
	if (event.key === 'ArrowLeft' && now > 0) {
    if (--now == 0) window.scrollTo({ top: 0, behavior: 'smooth' })
    else $(`[index="match-${now}"]`).scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
	else if (event.key === 'ArrowRight' && now <= counter) {
     if (++now == counter + 1) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
    else $(`[index="match-${now}"]`).scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

// Fix Name
$$('#thread a[href^="mailto:"]').forEach((info) => {
	let span = document.createElement('span')
	span.className = 'green'
	span.innerHTML = info.innerHTML
	info.parentNode.replaceChild(span, info)
})

// Fix Image and Video
$$('#thread a[target="_blank"][rel="noopener"]').forEach((ele) => {
	const url = ele.getAttribute('href')

	if (['.mp4'].some(ext => url.toLowerCase().includes(ext))) {
		let source = document.createElement('source')
		source.type = 'video/mp4'
		source.src = url

		var video = document.createElement('video')
		video.className = 'thumbnail'
		video.controls = true

		ele.display = 'block'
		video.appendChild(source)

		ele.parentNode.replaceChild(video, ele)
	} else if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '?format=jpg'].some(ext => url.toLowerCase().includes(ext))) {
		ele.textContent = ''

		let img = document.createElement('img')
		img.className = 'thumbnail'
		img.src = url

		ele.display = 'block'
		ele.appendChild(img)
	} else if (['imgur.com'].some(ext => url.toLowerCase().includes(ext))) {
		ele.textContent = ''

		let img = document.createElement('img')
		img.className = 'thumbnail'
		img.src = `${url}.jpg`

		ele.display = 'block'
		ele.appendChild(img)
	}
})

// Pageend Button
let img = document.createElement('img')
img.style.paddingTop = '13px'
img.src = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20height%3D%2224%22%20viewBox%3D%220%20-960%20960%20960%22%20width%3D%2224%22%20fill%3D%22%23000%22%3E%3Cg%20transform%3D%22rotate(180%2C%20480%2C%20-480)%22%3E%3Cpath%20d%3D%22m296-345-56-56%20240-240%20240%20240-56%2056-184-183-184%20183Z%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E'

let a = document.createElement('a')
a.appendChild(img)

let p = document.createElement('p')
p.id = 'pageend'
p.classList.add('rounded-circle', 'shadow-sm')
p.appendChild(a)

p.onclick = () => {
	window.scrollTo({
		top: document.body.scrollHeight,
		behavior: 'smooth'
	})
}

$('#pagetop').insertAdjacentElement('afterend', p)

// Create Tooltip
let tooltip = document.createElement('div')
tooltip.id = 'tooltip'
document.body.appendChild(tooltip)

const threadId = window.location.href.split('/')[6]
const response = await fetch(`https://edge.jpnkn.com/p/hololiveneet/${threadId}/js`)
const buffer = await response.arrayBuffer()
const threadData = new TextDecoder('shift_jis').decode(buffer).slice(12, -2).split('\\n')

const getDataHtml = (index) => {
	const data = threadData[index - 1]
		.match(/(.*?) <\/b>\((.*? [a-zA-Z0-9]{4}-[a-zA-Z0-9]{4})\)<b><>.*?<>(\d{4}\/\d{2}\/\d{2}\(.\)) (\d{2}:\d{2}:\d{2}\.\d{2}) ID:([a-zA-Z0-9]{8})<>(.*?)<>/)
	let content = data[6]
		.replace(/&gt;&gt;(\d{1,4})/g, `<a href="/test/read.cgi/hololiveneet/${threadId}/$1">&gt;&gt;$1</a>`)
		.replace(/(https?:\/\/[^<\s]+(jpg|jpeg|png|gif)[^<\s]*)/g, '<a href="$1" target="_blank" rel="noopener"><img class="thumbnail" src="$1"></a>')

	return `
		<div class="media res my-4" data-res-index="${index}">
			<div class="media-body">
				<dt class="info">${index} ：
					<span class="green">
						<b>${data[1]} </b>
						(${data[2]})
						<b></b>
					</span>
					 ${data[3]} ${data[4]} ID:${data[5]}
				</dt>
				<dd>${content}</dd>
			</div>
		</div>
	`
}

const handleWheel = (event) => {
	event.preventDefault()
	tooltip.scrollBy({
		top: event.deltaY,
		left: 0,
		behavior: 'smooth'
	})
}

// Find Quoted Thread
$$('#thread a[href^="/test/read.cgi/hololiveneet/"]').forEach((ele) => {
	ele.onmouseover = () => {
		let html = ''

		let pattern = /&gt;&gt;(\d{1,4})/
		let index = ele.textContent.slice(2)

		while (true) {
			let data = getDataHtml(index)
			html = data + html

			if (!pattern.test(data)) break

			let match = data.match(pattern)[1]
			index = match
		}

		tooltip.innerHTML = html
		tooltip.style.display = 'block'

		ele.addEventListener('wheel', handleWheel)
	}

	ele.onmouseout = () => {
		tooltip.style.display = 'none'
		tooltip.innerHTML = ''

		ele.removeEventListener('wheel', handleWheel)
	}
})

// List Quoted Threads
$$('#thread .info > span').forEach((ele) => {
	const textNode = ele.previousSibling
	const threadIndex = textNode.textContent.slice(0, -2)

	let count = 0

	threadData.forEach((thread) => {
		if (new RegExp(`&gt;&gt;${threadIndex}(?!\\d)`).test(thread)) count++
	})

	if (count == 0) return

	let a = document.createElement('a')
	a.href = ''
	a.textContent = `${threadIndex}(${count})`
	ele.parentNode.insertBefore(a, textNode)

	textNode.textContent = ' ：'

	a.onmouseover = () => {
		let html = ''

		threadData.forEach((thread, index) => {
			if (new RegExp(`&gt;&gt;${threadIndex}(?!\\d)`).test(thread)) html += getDataHtml(index + 1)
		})

		if (html == '') return

		tooltip.innerHTML = html
		tooltip.style.display = 'block'

		a.addEventListener('wheel', handleWheel)
	}

	a.onmouseout = () => {
		tooltip.style.display = 'none'
		tooltip.innerHTML = ''

		a.removeEventListener('wheel', handleWheel)
	}
})
