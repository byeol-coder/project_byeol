let lastMove = 0;
function isContextValid() { return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id; }

document.addEventListener('mousemove', (e) => {
    if (!isContextValid()) return;
    const now = Date.now();
    if (now - lastMove > 150) {
        try {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const text = el ? (el.innerText || el.alt || el.ariaLabel || el.title || "") : "";
            chrome.runtime.sendMessage({
                action: "mouseMove",
                dpr: window.devicePixelRatio || 1,
                text: text.trim(),
                rect: { x: Math.max(0, e.clientX - 100), y: Math.max(0, e.clientY - 75), width: 200, height: 150 }
            }).catch(() => {});
            lastMove = now;
        } catch (err) {}
    }
});

document.addEventListener('focusin', (e) => {
    if (!isContextValid()) return;
    const el = e.target;
    const rect = el.getBoundingClientRect();
    chrome.runtime.sendMessage({
        action: "focusTracking",
        dpr: window.devicePixelRatio || 1,
        text: (el.innerText || el.alt || "").trim(),
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    }).catch(() => {});
});