// ==UserScript==
// @name               アンスレ
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

if (!$('#black-mode')) {
	let style = document.createElement('style')
	style.id = 'black-mode'
	style.textContent = `
    body,
    .main > * {
      background-color: black !important;
      color: white !important;
    }

    #write,
    .tgWrite,
		#pagetop {
      display: none !important;
    }

    .thumbnail {
      max-width: 80% !important;
      max-height: 80vh !important;
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
			top: 15vh !important;
      background-color: #333333 !important;
			padding: 5px !important;
			border-radius: 5px !important;
			border: 5px solid white !important;
      max-height: 80vh !important;
			overflow-y: auto !important;
		}

		#tooltip > .media {
			margin: 0px !important;
			border: none !important;
		}

		#tooltip .thumbnail {
			max-width: 80% !important;
      max-height: 60vh !important;
			margin: 0.1em !important;
		}
  `
	document.head.appendChild(style)
}

if (!$('#pageend')) {
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
}

$$('#thread a[href="mailto:sage"]').forEach((info) => {
	let span = document.createElement('span')
	span.className = 'green'
	span.innerHTML = info.innerHTML
	info.parentNode.replaceChild(span, info)
})

$$('#thread a[target="_blank"][rel="noopener"]').forEach((ele) => {
	const url = ele.getAttribute('href')

	if (['.jpg', '.jpeg', '.png', '.gif', '?format=jpg', 'imgur.com'].some(ext => url.toLowerCase().includes(ext))) {
		ele.textContent = ''

		let img = document.createElement('img')
		img.className = 'thumbnail'
		img.src = url

		ele.appendChild(img)
	} else if (['.mp4'].some(ext => url.toLowerCase().includes(ext))) {
		let source = document.createElement('source')
		source.type = 'video/mp4'
		source.src = url

		var video = document.createElement('video')
		video.className = 'thumbnail'
		video.controls = true

		video.appendChild(source)

		ele.parentNode.replaceChild(video, ele)
	}
})

let tooltip = document.createElement('div')
tooltip.id = 'tooltip'
document.body.appendChild(tooltip)

const response = await fetch(`https://edge.jpnkn.com/p/hololiveneet/${window.location.href.split('/')[6]}/js`)
const buffer = await response.arrayBuffer()
const threadData = new TextDecoder('shift_jis').decode(buffer).slice(12, -2).split('\\n')

const getDataHtml = (index) => {
	const data = threadData[index-1]
		.match(/(.*?) <\/b>\((.*? [a-zA-Z0-9]{4}-[a-zA-Z0-9]{4})\)<b><>.*?<>(\d{4}\/\d{2}\/\d{2}\(.\)) (\d{2}:\d{2}:\d{2}\.\d{2}) ID:([a-zA-Z0-9]{8})<>(.*?)<>/)
	let content = data[6]
		.replace(/&gt;&gt;(\d{1,4})/, `<a href="">&gt;&gt;$1</a>`)
		.replace(/(https:\/\/[^<\s]+(jpg|jpeg|png|gif)[^<\s]*)/g, '<a href="$1" target="_blank" rel="noopener"><img class="thumbnail" src="$1"></a>')

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

$$('#thread a[href^="/test/read.cgi/hololiveneet/"]').forEach((ele) => {
	ele.onmouseover = () => {
		tooltip.innerHTML = getDataHtml(ele.textContent.slice(2))
		tooltip.style.display = 'block'
		tooltip.style.left = '10vw'
		tooltip.style.maxWidth = '85vw'

		ele.addEventListener('wheel', handleWheel)
	}

	ele.onmouseout = () => {
		tooltip.style.display = 'none'
		tooltip.innerHTML = ''

		ele.removeEventListener('wheel', handleWheel)
	}
})

$$('#thread .info').forEach((ele) => {
	let a = document.createElement('a')
	a.id = 'threads'
	a.href = ''
	a.textContent = ' >>関連スレ'

	ele.appendChild(a)

	a.onmouseover = () => {
		const threadIndex = ele.parentElement.parentElement.getAttribute('data-res-index')

		let html = ''

		threadData.forEach((thread, index) => {
			if (new RegExp(`&gt;&gt;${threadIndex}(?!\\d)`).test(thread)) html += getDataHtml(index+1)
		})

		if (html == '') return

		tooltip.innerHTML = html
		tooltip.style.display = 'block'
		tooltip.style.left = '1vw'
		tooltip.style.maxWidth = '55vw'

		a.addEventListener('wheel', handleWheel)
	}

	a.onmouseout = () => {
		tooltip.style.display = 'none'
		tooltip.innerHTML = ''

		a.removeEventListener('wheel', handleWheel)
	}
})
