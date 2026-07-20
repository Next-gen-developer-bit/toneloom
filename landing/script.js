/* Production Chrome Web Store URL — update with your extension ID when published */
const CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/echowrite'

const SITE_ORIGIN = window.location.origin

const yearEl = document.getElementById('year')
if (yearEl) yearEl.textContent = String(new Date().getFullYear())

const header = document.querySelector('.site-header')
const onScroll = () => {
  if (!header) return
  header.classList.toggle('is-scrolled', window.scrollY > 8)
}
onScroll()
window.addEventListener('scroll', onScroll, { passive: true })

document.querySelectorAll('[data-chrome-cta]').forEach((el) => {
  el.setAttribute('href', CHROME_STORE_URL)
  el.setAttribute('target', '_blank')
  el.setAttribute('rel', 'noopener noreferrer')
})

const canonical = document.querySelector('link[rel="canonical"]')
if (canonical && SITE_ORIGIN) {
  canonical.setAttribute('href', `${SITE_ORIGIN}/`)
}

const revealEls = document.querySelectorAll('.reveal')
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          io.unobserve(entry.target)
        }
      })
    },
    { threshold: 0.18, rootMargin: '0px 0px -40px 0px' }
  )
  revealEls.forEach((el) => io.observe(el))
} else {
  revealEls.forEach((el) => el.classList.add('is-visible'))
}
